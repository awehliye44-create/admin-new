import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  FareEngine,
  type FarePricingSettings,
} from "../_shared/fareEngine.ts";
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

// ─── Helpers ───────────────────────────────────────────────────────────────

interface ZoneInfo {
  zone_id: string;
  zone_name: string;
  is_airport: boolean;
}

async function resolveZoneWithType(
  supabase: any,
  lat: number,
  lng: number,
  region_id: string,
): Promise<ZoneInfo | null> {
  const z = await resolvePricingZone({ supabase, lat, lng, region_id });
  if (!z) return null;
  const { data } = await supabase
    .from("custom_zones")
    .select("zone_type")
    .eq("id", z.zone_id)
    .maybeSingle();
  const is_airport = (data?.zone_type ?? "").toLowerCase().trim() === "airport";
  return { ...z, is_airport };
}

interface ChipPreset {
  id: string;
  label: string;
  value: number; // FLAT = currency units; PERCENT = % of totalFare
}

interface OfferSettings {
  enabled?: boolean;
  presetType?: "FLAT" | "PERCENT";
  presets?: ChipPreset[];
}

function computeChipsPence(
  totalFarePence: number,
  offerSettings: OfferSettings | null,
): { id: string; label: string; amountPence: number }[] {
  if (!offerSettings?.enabled || !offerSettings.presets?.length) return [];
  const type = offerSettings.presetType ?? "PERCENT";
  return offerSettings.presets.map((p) => {
    let amountPence: number;
    if (type === "FLAT") {
      amountPence = totalFarePence + Math.round((p.value ?? 0) * 100);
    } else {
      const pct = Number(p.value ?? 0) / 100;
      amountPence = Math.round(totalFarePence * (1 + pct));
    }
    return { id: p.id, label: p.label, amountPence };
  });
}

function computeDriverKeep(
  baseFarePence: number,
  airportChargePence: number,
  commissionPct: number,
): { driverKeepPence: number; commissionPence: number } {
  const commissionPence = Math.round(
    (baseFarePence * Math.max(0, commissionPct)) / 100,
  );
  const driverKeepPence = (baseFarePence - commissionPence) + airportChargePence;
  return { driverKeepPence, commissionPence };
}

function buildFareDetails(
  baseFarePence: number,
  airportChargePence: number,
  currency: string,
) {
  const out = [{ label: "Fare", amountPence: baseFarePence }];
  if (airportChargePence > 0) {
    out.push({ label: "Airport charge", amountPence: airportChargePence });
  }
  return out;
}

// ─── Handler ───────────────────────────────────────────────────────────────

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

    if (
      pickup_lat != null && pickup_lng != null &&
      dropoff_lat != null && dropoff_lng != null
    ) {
      try {
        const directions = await getDirections(
          pickup_lat, pickup_lng,
          dropoff_lat, dropoff_lng,
          waypoints,
        );
        estimated_distance_km = directions.distance_km;
        estimated_duration_min = directions.duration_min;
        directions_polyline = directions.polyline;
      } catch (dirErr) {
        console.warn("[estimate-fare] Directions API failed:", dirErr);
        if (estimated_distance_km == null || estimated_duration_min == null) {
          return new Response(
            JSON.stringify({ error: "Could not calculate route." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }
    }

    if (!service_area_id || estimated_distance_km == null || estimated_duration_min == null) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: saData } = await supabase
      .from("service_areas")
      .select("region_id, region:regions(currency_code, distance_unit)")
      .eq("id", service_area_id)
      .single();

    const regionCurrency = (saData?.region as any)?.currency_code;
    const regionDistanceUnit = (saData?.region as any)?.distance_unit ?? 'km';
    const regionId = saData?.region_id ?? null;

    if (!regionCurrency) {
      return new Response(
        JSON.stringify({
          error: "REGION_CURRENCY_UNRESOLVABLE",
          error_code: "REGION_CURRENCY_UNRESOLVABLE",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Resolve zones once + check airport type
    let pickupZone: ZoneInfo | null = null;
    let dropoffZone: ZoneInfo | null = null;

    if (
      regionId &&
      pickup_lat != null && pickup_lng != null &&
      dropoff_lat != null && dropoff_lng != null
    ) {
      [pickupZone, dropoffZone] = await Promise.all([
        resolveZoneWithType(supabase, pickup_lat, pickup_lng, regionId),
        resolveZoneWithType(supabase, dropoff_lat, dropoff_lng, regionId),
      ]);
    }

    const isAirportTrip =
      (pickupZone?.is_airport === true) || (dropoffZone?.is_airport === true);

    // ─── Quote helper: returns the full pricing envelope for one vehicle ───
    async function quoteForVehicle(
      vtId: string,
      engineSettings: any,
      savRow: {
        commission_percentage: number;
        offer_settings: OfferSettings | null;
        airport_charge_pence: number;
      },
    ) {
      const zoneResolution = await resolveZoneRoutePricing({
        supabase,
        from_zone_id: pickupZone?.zone_id ?? null,
        to_zone_id: dropoffZone?.zone_id ?? null,
        vehicle_type_id: vtId,
        service_area_id,
      });

      let baseFarePence = 0;
      let airportChargePence = 0;
      let pricingMode: "NORMAL_DISTANCE_TIME" | "ROUTE_PRICING";
      let meterBreakdown: any = null;

      if (zoneResolution.row) {
        const q = applyZoneRoutePricing(zoneResolution.row);
        baseFarePence = q.base_fare_pence;
        // Route pricing has its OWN airport_charge field (admin set per-route)
        airportChargePence = isAirportTrip ? q.airport_charge_pence : 0;
        pricingMode = "ROUTE_PRICING";
      } else {
        const engine = new FareEngine(engineSettings as FarePricingSettings);
        meterBreakdown = engine.estimateFare({
          estimated_distance_km,
          estimated_duration_min,
          stops_count,
        });
        baseFarePence = meterBreakdown.quoted_fare_pence;
        // Normal pricing: airport charge from the vehicle's SAV row
        airportChargePence = isAirportTrip ? (savRow.airport_charge_pence ?? 0) : 0;
        pricingMode = "NORMAL_DISTANCE_TIME";
      }

      const totalFarePence = baseFarePence + airportChargePence;
      const commissionPct = Number(savRow.commission_percentage ?? 0);
      const { driverKeepPence, commissionPence } = computeDriverKeep(
        baseFarePence, airportChargePence, commissionPct,
      );
      const chips = computeChipsPence(totalFarePence, savRow.offer_settings);
      const fareDetails = buildFareDetails(baseFarePence, airportChargePence, regionCurrency);

      return {
        pricingMode,
        baseFarePence,
        airportChargePence,
        totalFarePence,
        driverKeepPence,
        commissionPence,
        driverTierCommissionPercent: commissionPct,
        chips,
        fareDetails,
        meterBreakdown,
        zoneDebug: {
          pickup_zone: pickupZone,
          dropoff_zone: dropoffZone,
          is_airport_trip: isAirportTrip,
          route_pricing_row_id: zoneResolution.pricing_row_id,
          route_pricing_source: zoneResolution.source,
        },
      };
    }

    // ─── BATCH MODE ───
    if (!vehicle_type_id) {
      const { data: savRows, error: savErr } = await supabase
        .from("service_area_vehicle_pricing")
        .select("vehicle_type_id, commission_percentage, offer_settings, airport_charge_pence")
        .eq("service_area_id", service_area_id)
        .eq("is_enabled", true);

      if (savErr) {
        return new Response(
          JSON.stringify({ error: "Failed to fetch vehicle pricing" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const assignedVtIds = (savRows || []).map((r: any) => r.vehicle_type_id);
      if (assignedVtIds.length === 0) {
        return new Response(
          JSON.stringify({ error: "No active vehicle types in this service area", vehicles: [] }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const savByVt = new Map(
        (savRows || []).map((r: any) => [r.vehicle_type_id, r]),
      );

      const { data: allFareSettings } = await supabase
        .from("fare_pricing_settings").select("*").eq("service_area_id", service_area_id);
      const fareMap = new Map<string | null, any>();
      for (const fs of allFareSettings || []) fareMap.set(fs.vehicle_type_id, fs);
      const defaultSettings = fareMap.get(null) || null;

      const { data: vtMeta } = await supabase
        .from("vehicle_types")
        .select("id, name, slug, description, icon, capacity, features, display_order")
        .in("id", assignedVtIds).eq("is_active", true);
      const vtMetaMap = new Map((vtMeta || []).map((v: any) => [v.id, v]));

      const vehicles: any[] = [];
      for (const vtId of assignedVtIds) {
        const meta = vtMetaMap.get(vtId);
        const engineSettings = fareMap.get(vtId) || defaultSettings;
        const savRow = savByVt.get(vtId);
        if (!meta || !engineSettings || !savRow) continue;

        const q = await quoteForVehicle(vtId, engineSettings, savRow as any);

        vehicles.push({
          vehicleTypeId: vtId,
          vehicleTypeName: meta.name,
          vehicleSlug: meta.slug,
          vehicleIcon: meta.icon,
          vehicleCapacity: meta.capacity,
          vehicleDescription: meta.description,
          vehicleFeatures: meta.features,
          displayOrder: meta.display_order ?? 0,
          pricingMode: q.pricingMode,
          currencyCode: regionCurrency,
          baseFarePence: q.baseFarePence,
          airportChargePence: q.airportChargePence,
          totalFarePence: q.totalFarePence,
          driverKeepPence: q.driverKeepPence,
          driverTierCommissionPercent: q.driverTierCommissionPercent,
          chips: q.chips,
          fareDetails: q.fareDetails,
          // Back-compat for existing clients still reading these:
          quotedFarePence: q.totalFarePence,
          finalTotalPence: q.totalFarePence,
          fareEngineConfigId: engineSettings.id,
          fareLocked: q.pricingMode === "ROUTE_PRICING" || engineSettings.pricing_mode === "fixed",
          zoneDebug: q.zoneDebug,
          fareSnapshotJson: {
            config_id: engineSettings.id,
            pricing_mode: q.pricingMode,
            base_fare_pence: q.baseFarePence,
            airport_charge_pence: q.airportChargePence,
            total_fare_pence: q.totalFarePence,
            commission_pct: q.driverTierCommissionPercent,
            currency_code: regionCurrency,
            snapshot_at: new Date().toISOString(),
          },
          freeWaitingMinutes: engineSettings.free_waiting_minutes,
          waitingPerMinutePence: engineSettings.waiting_per_minute_pence,
          extraStopFlatFeePence: engineSettings.extra_stop_flat_fee_pence,
        });
      }

      vehicles.sort((a, b) => a.displayOrder - b.displayOrder);

      return new Response(
        JSON.stringify({
          estimatedDistanceKm: estimated_distance_km,
          estimatedDurationMin: estimated_duration_min,
          currencyCode: regionCurrency,
          vehicles,
          zoneContext: { pickup_zone: pickupZone, dropoff_zone: dropoffZone, is_airport_trip: isAirportTrip },
          ...(directions_polyline ? { routePolyline: directions_polyline } : {}),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── SINGLE VEHICLE MODE ───
    const { data: savRow } = await supabase
      .from("service_area_vehicle_pricing")
      .select("commission_percentage, offer_settings, airport_charge_pence")
      .eq("service_area_id", service_area_id)
      .eq("vehicle_type_id", vehicle_type_id)
      .eq("is_enabled", true)
      .maybeSingle();

    if (!savRow) {
      return new Response(
        JSON.stringify({
          error: "Vehicle type is not available in this service area",
          code: "VEHICLE_TYPE_NOT_AVAILABLE",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let engineSettings: any = null;
    const { data: vtSettings } = await supabase
      .from("fare_pricing_settings").select("*")
      .eq("service_area_id", service_area_id)
      .eq("vehicle_type_id", vehicle_type_id).maybeSingle();
    engineSettings = vtSettings;
    if (!engineSettings) {
      const { data: defaults } = await supabase
        .from("fare_pricing_settings").select("*")
        .eq("service_area_id", service_area_id).is("vehicle_type_id", null).maybeSingle();
      engineSettings = defaults;
    }
    if (!engineSettings) {
      return new Response(
        JSON.stringify({ error: "Fare pricing settings not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const q = await quoteForVehicle(vehicle_type_id, engineSettings, savRow as any);

    return new Response(
      JSON.stringify({
        pricingMode: q.pricingMode,
        currencyCode: regionCurrency,
        vehicleTypeId: vehicle_type_id,
        baseFarePence: q.baseFarePence,
        airportChargePence: q.airportChargePence,
        totalFarePence: q.totalFarePence,
        driverKeepPence: q.driverKeepPence,
        driverTierCommissionPercent: q.driverTierCommissionPercent,
        chips: q.chips,
        fareDetails: q.fareDetails,
        // Back-compat
        quotedFarePence: q.totalFarePence,
        finalTotalPence: q.totalFarePence,
        estimatedDistanceKm: estimated_distance_km,
        estimatedDurationMin: estimated_duration_min,
        fareEngineConfigId: engineSettings.id,
        fareLocked: q.pricingMode === "ROUTE_PRICING" || engineSettings.pricing_mode === "fixed",
        zoneDebug: q.zoneDebug,
        fareSnapshotJson: {
          config_id: engineSettings.id,
          pricing_mode: q.pricingMode,
          base_fare_pence: q.baseFarePence,
          airport_charge_pence: q.airportChargePence,
          total_fare_pence: q.totalFarePence,
          commission_pct: q.driverTierCommissionPercent,
          currency_code: regionCurrency,
          snapshot_at: new Date().toISOString(),
        },
        freeWaitingMinutes: engineSettings.free_waiting_minutes,
        waitingPerMinutePence: engineSettings.waiting_per_minute_pence,
        extraStopFlatFeePence: engineSettings.extra_stop_flat_fee_pence,
        ...(directions_polyline ? { routePolyline: directions_polyline } : {}),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("estimate-fare error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
