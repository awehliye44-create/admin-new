import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { FareEngine, type FarePricingSettings } from "../_shared/fareEngine.ts";

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
      estimated_distance_km,
      estimated_duration_min,
      vehicle_type_id,
      stops_count = 0,
    } = body;

    if (!service_area_id || estimated_distance_km == null || estimated_duration_min == null) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: service_area_id, estimated_distance_km, estimated_duration_min" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Resolve currency from Region (single source of truth) via service_area → region
    const { data: saData, error: saErr } = await supabase
      .from("service_areas")
      .select("region_id, region:regions(currency_code, distance_unit)")
      .eq("id", service_area_id)
      .single();

    if (saErr) {
      console.error("Error fetching service area region:", saErr);
    }

    const regionCurrency = (saData?.region as any)?.currency_code;

    if (!regionCurrency) {
      return new Response(
        JSON.stringify({ error: "REGION_CURRENCY_UNRESOLVABLE: Service area has no Region with currency_code configured.", error_code: "REGION_CURRENCY_UNRESOLVABLE" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── BATCH MODE (no vehicle_type_id) ───
    // Returns fares for ALL active vehicles in the service area.
    // This is the preferred mode for the mobile app.
    if (!vehicle_type_id) {
      // Step 1: Get ALL enabled vehicles from service_area_vehicle_pricing (SSOT)
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
      console.log(`[estimate-fare] BATCH: service_area=${service_area_id}, vehicles from service_area_vehicle_pricing: ${assignedVtIds.length}`, assignedVtIds);

      if (assignedVtIds.length === 0) {
        return new Response(
          JSON.stringify({ error: "No active vehicle types in this service area", vehicles: [] }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Step 2: Fetch ALL fare_pricing_settings for this service area
      const { data: allFareSettings, error: fareErr } = await supabase
        .from("fare_pricing_settings")
        .select("*")
        .eq("service_area_id", service_area_id);

      if (fareErr) {
        console.error("[estimate-fare] Error fetching fare settings:", fareErr);
      }

      // Build map: vehicle_type_id -> settings, null -> default
      const fareMap = new Map<string | null, any>();
      for (const fs of allFareSettings || []) {
        fareMap.set(fs.vehicle_type_id, fs);
      }

      const defaultSettings = fareMap.get(null) || null;
      console.log(`[estimate-fare] BATCH: fare configs found: ${fareMap.size} (default: ${defaultSettings ? 'yes' : 'no'})`);

      // Step 3: Fetch vehicle type metadata
      const { data: vtMeta, error: vtErr } = await supabase
        .from("vehicle_types")
        .select("id, name, slug, description, icon, capacity, features")
        .in("id", assignedVtIds)
        .eq("is_active", true);

      if (vtErr) {
        console.error("[estimate-fare] Error fetching vehicle metadata:", vtErr);
      }

      const vtMetaMap = new Map((vtMeta || []).map((v: any) => [v.id, v]));

      // Step 4: Calculate fare for EVERY assigned vehicle — NO FILTERING
      const vehicles: any[] = [];
      for (const vtId of assignedVtIds) {
        const settings = fareMap.get(vtId) || defaultSettings;
        const meta = vtMetaMap.get(vtId);

        if (!settings) {
          console.warn(`[estimate-fare] BATCH: No fare settings for vehicle ${vtId} and no default — SKIPPING (this should be configured)`);
          continue;
        }

        if (!meta) {
          console.warn(`[estimate-fare] BATCH: Vehicle type ${vtId} not found in vehicle_types or inactive — SKIPPING`);
          continue;
        }

        const engine = new FareEngine(settings as FarePricingSettings);
        const breakdown = engine.estimateFare({
          estimated_distance_km,
          estimated_duration_min,
          stops_count,
        });

        const fareLocked = settings.pricing_mode === "fixed";

        vehicles.push({
          vehicleTypeId: vtId,
          vehicleName: meta.name,
          vehicleSlug: meta.slug,
          vehicleIcon: meta.icon,
          vehicleCapacity: meta.capacity,
          vehicleDescription: meta.description,
          vehicleFeatures: meta.features,
          displayOrder: meta.display_order ?? 0,
          pricingMode: settings.pricing_mode,
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
            surgeMultiplier: breakdown.surge_multiplier ?? null,
            zoneMultiplier: breakdown.zone_multiplier ?? null,
            trafficMultiplier: breakdown.traffic_multiplier ?? null,
          },
          fareSnapshotJson: {
            config_id: settings.id,
            pricing_mode: settings.pricing_mode,
            base_fare_pence: settings.base_fare_pence,
            per_km_rate_pence: settings.per_km_rate_pence,
            per_min_rate_pence: settings.per_min_rate_pence,
            booking_fee_pence: settings.booking_fee_pence,
            minimum_fare_pence: settings.minimum_fare_pence,
            free_waiting_minutes: settings.free_waiting_minutes,
            waiting_per_minute_pence: settings.waiting_per_minute_pence,
            extra_stop_flat_fee_pence: settings.extra_stop_flat_fee_pence,
            currency_code: regionCurrency,
            enable_surge: settings.enable_surge,
            surge_multiplier_default: settings.surge_multiplier_default,
            snapshot_at: new Date().toISOString(),
          },
          freeWaitingMinutes: settings.free_waiting_minutes,
          waitingPerMinutePence: settings.waiting_per_minute_pence,
          extraStopFlatFeePence: settings.extra_stop_flat_fee_pence,
        });
      }

      // Sort by display order
      vehicles.sort((a: any, b: any) => a.displayOrder - b.displayOrder);

      console.log(`[estimate-fare] BATCH RESULT: ${vehicles.length} vehicles with fares (from ${assignedVtIds.length} assigned)`);

      // Build rider message
      const hasFixed = vehicles.some((v: any) => v.pricingMode === "fixed");
      const hasDynamic = vehicles.some((v: any) => v.pricingMode === "dynamic");
      let riderMessage = "Your fare is estimated and may change based on actual distance, time, and demand conditions.";
      if (hasFixed && !hasDynamic) {
        riderMessage = "Fixed fare confirmed. Your fare will not change due to route differences. Extra charges apply only for waiting time, added stops, or destination changes.";
      }

      return new Response(
        JSON.stringify({
          estimatedDistanceKm: estimated_distance_km,
          estimatedDurationMin: estimated_duration_min,
          currencyCode: regionCurrency,
          vehicles,
          riderMessage,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── SINGLE VEHICLE MODE (legacy, vehicle_type_id provided) ───
    // Validate vehicle_type_id is enabled in service_area_vehicle_pricing (SSOT)
    const { data: pricingRow } = await supabase
      .from("service_area_vehicle_pricing")
      .select("id")
      .eq("service_area_id", service_area_id)
      .eq("vehicle_type_id", vehicle_type_id)
      .eq("is_enabled", true)
      .maybeSingle();

    if (!pricingRow) {
      return new Response(
        JSON.stringify({
          error: "Vehicle type is not available in this service area",
          code: "VEHICLE_TYPE_NOT_AVAILABLE",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch fare pricing settings: try vehicle-type-specific first, fall back to area default
    let settings: any = null;

    const { data: vtSettings } = await supabase
      .from("fare_pricing_settings")
      .select("*")
      .eq("service_area_id", service_area_id)
      .eq("vehicle_type_id", vehicle_type_id)
      .maybeSingle();
    settings = vtSettings;

    if (!settings) {
      const { data: defaultSettings } = await supabase
        .from("fare_pricing_settings")
        .select("*")
        .eq("service_area_id", service_area_id)
        .is("vehicle_type_id", null)
        .maybeSingle();
      settings = defaultSettings;
    }

    if (!settings) {
      return new Response(
        JSON.stringify({ error: "Fare pricing settings not found for this service area" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const fareLocked = settings.pricing_mode === "fixed";
    const fareSnapshotJson = {
      config_id: settings.id,
      pricing_mode: settings.pricing_mode,
      base_fare_pence: settings.base_fare_pence,
      per_km_rate_pence: settings.per_km_rate_pence,
      per_min_rate_pence: settings.per_min_rate_pence,
      booking_fee_pence: settings.booking_fee_pence,
      minimum_fare_pence: settings.minimum_fare_pence,
      free_waiting_minutes: settings.free_waiting_minutes,
      waiting_per_minute_pence: settings.waiting_per_minute_pence,
      extra_stop_flat_fee_pence: settings.extra_stop_flat_fee_pence,
      currency_code: regionCurrency,
      enable_surge: settings.enable_surge,
      surge_multiplier_default: settings.surge_multiplier_default,
      snapshot_at: new Date().toISOString(),
    };

    const engine = new FareEngine(settings as FarePricingSettings);
    const breakdown = engine.estimateFare({
      estimated_distance_km,
      estimated_duration_min,
      stops_count,
    });

    const riderMessage =
      settings.pricing_mode === "fixed"
        ? "Fixed fare confirmed. Your fare will not change due to route differences. Extra charges apply only for waiting time, added stops, or destination changes."
        : "Your fare is estimated and may change based on actual distance, time, and demand conditions.";

    return new Response(
      JSON.stringify({
        pricingMode: settings.pricing_mode,
        currencyCode: regionCurrency,
        quotedFarePence: breakdown.quoted_fare_pence,
        estimatedDistanceKm: estimated_distance_km,
        estimatedDurationMin: estimated_duration_min,
        vehicleTypeId: vehicle_type_id,
        fareEngineConfigId: settings.id,
        fareLocked,
        fareSnapshotJson,
        fareBreakdown: {
          baseFarePence: breakdown.base_fare_pence,
          distanceChargePence: breakdown.distance_charge_pence,
          timeChargePence: breakdown.time_charge_pence,
          bookingFeePence: breakdown.booking_fee_pence,
          subtotalPence: breakdown.subtotal_pence,
          minimumApplied: breakdown.minimum_applied,
          surgeMultiplier: breakdown.surge_multiplier ?? null,
          zoneMultiplier: breakdown.zone_multiplier ?? null,
          trafficMultiplier: breakdown.traffic_multiplier ?? null,
        },
        riderMessage,
        freeWaitingMinutes: settings.free_waiting_minutes,
        waitingPerMinutePence: settings.waiting_per_minute_pence,
        extraStopFlatFeePence: settings.extra_stop_flat_fee_pence,
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
