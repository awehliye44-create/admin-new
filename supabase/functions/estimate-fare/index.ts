import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { FareEngine, type FarePricingSettings } from "../_shared/fareEngine.ts";
import { getDirections } from "../_shared/googleMaps.ts";
import {
  resolvePricingZone,
  resolveZoneRoutePricing,
  applyZoneRoutePricing,
} from "../_shared/zoneRoutePricing.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json();
    const {
      service_area_id,
      vehicle_type_id,
      stops_count = 0,
      pickup_lat,
      pickup_lng,
      dropoff_lat,
      dropoff_lng,
      waypoints,
      estimated_distance_km: client_distance_km,
      estimated_duration_min: client_duration_min,
    } = body;

    let estimated_distance_km = client_distance_km;
    let estimated_duration_min = client_duration_min;
    let directions_polyline: string | null = null;

    if (pickup_lat != null && pickup_lng != null && dropoff_lat != null && dropoff_lng != null) {
      try {
        const directions = await getDirections(
          pickup_lat, pickup_lng,
          dropoff_lat, dropoff_lng,
          waypoints
        );
        estimated_distance_km = directions.distance_km;
        estimated_duration_min = directions.duration_min;
        directions_polyline = directions.polyline;
        console.log(`[estimate-fare] Google Directions: ${estimated_distance_km}km, ${estimated_duration_min}min`);
      } catch (dirErr) {
        console.warn("[estimate-fare] Directions API failed, falling back to client estimates:", dirErr);
        if (estimated_distance_km == null || estimated_duration_min == null) {
          return new Response(
            JSON.stringify({ error: "Could not calculate route. Please provide pickup and dropoff coordinates." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }
    }

    if (!service_area_id || estimated_distance_km == null || estimated_duration_min == null) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: service_area_id, estimated_distance_km, estimated_duration_min" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Resolve currency + region from service area
    const { data: saData, error: saErr } = await supabase
      .from("service_areas")
      .select("region_id, region:regions(currency_code, distance_unit)")
      .eq("id", service_area_id)
      .single();

    if (saErr) console.error("Error fetching service area region:", saErr);

    const regionCurrency = (saData?.region as any)?.currency_code;
    const regionId = saData?.region_id ?? null;

    if (!regionCurrency) {
      return new Response(
        JSON.stringify({ error: "REGION_CURRENCY_UNRESOLVABLE: Service area has no Region with currency_code configured.", error_code: "REGION_CURRENCY_UNRESOLVABLE" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── Resolve pickup/dropoff PRICING zones once (shared across all vehicles) ───
    let pickupZone: { zone_id: string; zone_name: string } | null = null;
    let dropoffZone: { zone_id: string; zone_name: string } | null = null;

    if (regionId && pickup_lat != null && pickup_lng != null && dropoff_lat != null && dropoff_lng != null) {
      [pickupZone, dropoffZone] = await Promise.all([
        resolvePricingZone({ supabase, lat: pickup_lat, lng: pickup_lng, region_id: regionId }),
        resolvePricingZone({ supabase, lat: dropoff_lat, lng: dropoff_lng, region_id: regionId }),
      ]);
      console.log(`[estimate-fare] Zones resolved — pickup=${pickupZone?.zone_name ?? "none"} dropoff=${dropoffZone?.zone_name ?? "none"}`);
    }

    // Helper: compute fare for a single vehicle, applying zone-route pricing if any.
    async function quoteForVehicle(vtId: string, settings: any) {
      // 1. Try zone-route pricing for THIS vehicle category
      const zoneResolution = await resolveZoneRoutePricing({
        supabase,
        from_zone_id: pickupZone?.zone_id ?? null,
        to_zone_id: dropoffZone?.zone_id ?? null,
        vehicle_type_id: vtId,
        service_area_id,
      });

      let breakdown;
      let pricingSource: "zone_route" | "meter";
      let zoneRouteQuote: ReturnType<typeof applyZoneRoutePricing> | null = null;

      if (zoneResolution.row) {
        zoneRouteQuote = applyZoneRoutePricing(zoneResolution.row);
        pricingSource = "zone_route";
        breakdown = {
          base_fare_pence: zoneRouteQuote.fixed_fare_pence,
          distance_charge_pence: 0,
          time_charge_pence: 0,
          booking_fee_pence: 0,
          subtotal_pence: zoneRouteQuote.quoted_fare_pence,
          minimum_applied: false,
          quoted_fare_pence: zoneRouteQuote.quoted_fare_pence,
        };
      } else {
        // 2. Standard meter pricing
        const engine = new FareEngine(settings as FarePricingSettings);
        breakdown = engine.estimateFare({
          estimated_distance_km,
          estimated_duration_min,
          stops_count,
        });
        pricingSource = "meter";
      }

      return {
        breakdown,
        pricingSource,
        zoneRouteQuote,
        zoneDebug: {
          pickup_zone: pickupZone,
          dropoff_zone: dropoffZone,
          route_pricing_row_id: zoneResolution.pricing_row_id,
          route_pricing_source: zoneResolution.source,
          route_pricing_fallback_reason: zoneResolution.fallback_reason,
          vehicle_type_id_used: vtId,
        },
      };
    }

    // ─── BATCH MODE ───
    if (!vehicle_type_id) {
      const { data: pricingRows, error: pricingErr } = await supabase
        .from("service_area_vehicle_pricing")
        .select("vehicle_type_id")
        .eq("service_area_id", service_area_id)
        .eq("is_enabled", true);

      if (pricingErr) {
        console.error("[estimate-fare] Error fetching service_area_vehicle_pricing:", pricingErr);
        return new Response(
          JSON.stringify({ error: "Failed to fetch vehicle types" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const assignedVtIds = (pricingRows || []).map((a: any) => a.vehicle_type_id);

      if (assignedVtIds.length === 0) {
        return new Response(
          JSON.stringify({ error: "No active vehicle types in this service area", vehicles: [] }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { data: allFareSettings } = await supabase
        .from("fare_pricing_settings")
        .select("*")
        .eq("service_area_id", service_area_id);

      const fareMap = new Map<string | null, any>();
      for (const fs of allFareSettings || []) fareMap.set(fs.vehicle_type_id, fs);
      const defaultSettings = fareMap.get(null) || null;

      const { data: vtMeta } = await supabase
        .from("vehicle_types")
        .select("id, name, slug, description, icon, capacity, features, display_order")
        .in("id", assignedVtIds)
        .eq("is_active", true);

      const vtMetaMap = new Map((vtMeta || []).map((v: any) => [v.id, v]));

      const vehicles: any[] = [];
      for (const vtId of assignedVtIds) {
        const settings = fareMap.get(vtId) || defaultSettings;
        const meta = vtMetaMap.get(vtId);
        if (!settings || !meta) continue;

        const { breakdown, pricingSource, zoneRouteQuote, zoneDebug } = await quoteForVehicle(vtId, settings);
        const fareLocked = settings.pricing_mode === "fixed" || pricingSource === "zone_route";

        vehicles.push({
          vehicleTypeId: vtId,
          vehicleName: meta.name,
          vehicleSlug: meta.slug,
          vehicleIcon: meta.icon,
          vehicleCapacity: meta.capacity,
          vehicleDescription: meta.description,
          vehicleFeatures: meta.features,
          displayOrder: meta.display_order ?? 0,
          pricingMode: pricingSource === "zone_route" ? "fixed" : settings.pricing_mode,
          pricingSource,
          currencyCode: regionCurrency,
          quotedFarePence: breakdown.quoted_fare_pence,
          fareEngineConfigId: settings.id,
          fareLocked,
          fareBreakdown: {
            baseFarePence: breakdown.base_fare_pence,
            distanceChargePence: breakdown.distance_charge_pence,
            timeChargePence: breakdown.time_charge_pence,
            bookingFeePence: breakdown.booking_fee_pence,
            subtotalPence: breakdown.subtotal_pence,
            minimumApplied: breakdown.minimum_applied,
            zoneRoute: zoneRouteQuote,
          },
          zoneDebug,
          fareSnapshotJson: {
            config_id: settings.id,
            pricing_mode: pricingSource === "zone_route" ? "fixed" : settings.pricing_mode,
            pricing_source: pricingSource,
            zone_route_pricing_row_id: zoneDebug.route_pricing_row_id,
            zone_route_source: zoneDebug.route_pricing_source,
            currency_code: regionCurrency,
            snapshot_at: new Date().toISOString(),
          },
          freeWaitingMinutes: settings.free_waiting_minutes,
          waitingPerMinutePence: settings.waiting_per_minute_pence,
          extraStopFlatFeePence: settings.extra_stop_flat_fee_pence,
        });
      }

      vehicles.sort((a: any, b: any) => a.displayOrder - b.displayOrder);

      console.log(`[estimate-fare] BATCH: ${vehicles.length} vehicles quoted (zone_route=${vehicles.filter(v=>v.pricingSource==='zone_route').length})`);

      return new Response(
        JSON.stringify({
          estimatedDistanceKm: estimated_distance_km,
          estimatedDurationMin: estimated_duration_min,
          currencyCode: regionCurrency,
          vehicles,
          zoneContext: {
            pickup_zone: pickupZone,
            dropoff_zone: dropoffZone,
          },
          ...(directions_polyline ? { routePolyline: directions_polyline } : {}),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── SINGLE VEHICLE MODE ───
    const { data: pricingRow } = await supabase
      .from("service_area_vehicle_pricing")
      .select("id")
      .eq("service_area_id", service_area_id)
      .eq("vehicle_type_id", vehicle_type_id)
      .eq("is_enabled", true)
      .maybeSingle();

    if (!pricingRow) {
      return new Response(
        JSON.stringify({ error: "Vehicle type is not available in this service area", code: "VEHICLE_TYPE_NOT_AVAILABLE" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let settings: any = null;
    const { data: vtSettings } = await supabase
      .from("fare_pricing_settings").select("*")
      .eq("service_area_id", service_area_id).eq("vehicle_type_id", vehicle_type_id).maybeSingle();
    settings = vtSettings;
    if (!settings) {
      const { data: defaultSettings } = await supabase
        .from("fare_pricing_settings").select("*")
        .eq("service_area_id", service_area_id).is("vehicle_type_id", null).maybeSingle();
      settings = defaultSettings;
    }
    if (!settings) {
      return new Response(
        JSON.stringify({ error: "Fare pricing settings not found for this service area" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { breakdown, pricingSource, zoneRouteQuote, zoneDebug } = await quoteForVehicle(vehicle_type_id, settings);
    const fareLocked = settings.pricing_mode === "fixed" || pricingSource === "zone_route";

    return new Response(
      JSON.stringify({
        pricingMode: pricingSource === "zone_route" ? "fixed" : settings.pricing_mode,
        pricingSource,
        currencyCode: regionCurrency,
        quotedFarePence: breakdown.quoted_fare_pence,
        estimatedDistanceKm: estimated_distance_km,
        estimatedDurationMin: estimated_duration_min,
        vehicleTypeId: vehicle_type_id,
        fareEngineConfigId: settings.id,
        fareLocked,
        zoneDebug,
        fareSnapshotJson: {
          config_id: settings.id,
          pricing_mode: pricingSource === "zone_route" ? "fixed" : settings.pricing_mode,
          pricing_source: pricingSource,
          zone_route_pricing_row_id: zoneDebug.route_pricing_row_id,
          zone_route_source: zoneDebug.route_pricing_source,
          currency_code: regionCurrency,
          snapshot_at: new Date().toISOString(),
        },
        fareBreakdown: {
          baseFarePence: breakdown.base_fare_pence,
          distanceChargePence: breakdown.distance_charge_pence,
          timeChargePence: breakdown.time_charge_pence,
          bookingFeePence: breakdown.booking_fee_pence,
          subtotalPence: breakdown.subtotal_pence,
          minimumApplied: breakdown.minimum_applied,
          zoneRoute: zoneRouteQuote,
        },
        freeWaitingMinutes: settings.free_waiting_minutes,
        waitingPerMinutePence: settings.waiting_per_minute_pence,
        extraStopFlatFeePence: settings.extra_stop_flat_fee_pence,
        ...(directions_polyline ? { routePolyline: directions_polyline } : {}),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("estimate-fare error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
