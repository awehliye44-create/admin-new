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

    // Validate vehicle_type_id is assigned to this service area (if provided)
    if (vehicle_type_id) {
      const { data: assignment, error: assignError } = await supabase
        .from('service_area_vehicle_types')
        .select('id')
        .eq('service_area_id', service_area_id)
        .eq('vehicle_type_id', vehicle_type_id)
        .eq('is_active', true)
        .maybeSingle();

      if (assignError) {
        console.error('Error checking vehicle type assignment:', assignError);
      }

      if (!assignment) {
        return new Response(
          JSON.stringify({ 
            error: "Vehicle type is not available in this service area",
            code: "VEHICLE_TYPE_NOT_AVAILABLE"
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Fetch fare pricing settings: try vehicle-type-specific first, fall back to area default
    let settings: any = null;

    if (vehicle_type_id) {
      const { data } = await supabase
        .from("fare_pricing_settings")
        .select("*")
        .eq("service_area_id", service_area_id)
        .eq("vehicle_type_id", vehicle_type_id)
        .maybeSingle();
      settings = data;
    }

    // Fallback to area-wide default (vehicle_type_id IS NULL)
    if (!settings) {
      const { data, error } = await supabase
        .from("fare_pricing_settings")
        .select("*")
        .eq("service_area_id", service_area_id)
        .is("vehicle_type_id", null)
        .maybeSingle();
      if (error) {
        console.error("Error fetching default fare settings:", error);
      }
      settings = data;
    }

    if (!settings) {
      return new Response(
        JSON.stringify({ error: "Fare pricing settings not found for this service area" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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

    const regionCurrency = (saData?.region as any)?.currency_code || settings.currency_code || "GBP";
    const regionDistanceUnit = (saData?.region as any)?.distance_unit || "mile";

    // Determine fare lock status based on pricing mode (source of truth)
    const fareLocked = settings.pricing_mode === "fixed";

    // Build fare snapshot for downstream persistence
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

    // Build rider message based on pricing mode
    const riderMessage =
      settings.pricing_mode === "fixed"
        ? "Fixed fare confirmed. Your fare will not change due to route differences. Extra charges apply only for waiting time, added stops, or destination changes."
        : "Your fare is estimated and may change based on actual distance, time, and demand conditions.";

    return new Response(
      JSON.stringify({
        pricingMode: settings.pricing_mode,
        currencyCode: settings.currency_code,
        quotedFarePence: breakdown.quoted_fare_pence,
        estimatedDistanceKm: estimated_distance_km,
        estimatedDurationMin: estimated_duration_min,
        vehicleTypeId: vehicle_type_id || null,
        // Fare Engine source-of-truth fields for downstream persistence
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
