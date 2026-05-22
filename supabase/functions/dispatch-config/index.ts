// Public dispatch config endpoint consumed by Android & iOS apps.
// Returns the global dispatch + stacked rides configuration in a stable,
// mobile-friendly format. Safe defaults are returned if config is missing
// so apps never crash.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const DEFAULTS = {
  dispatch: {
    driver_response_timeout_seconds: 180,
    start_radius_meters: 4000,
    expand_radius_meters: 8000,
    max_radius_meters: 13000,
    drivers_per_wave: 3,
    wave_delay_seconds: 15,
    dispatch_mode: "smart_score",
  },
  stacked_rides: {
    enabled: true,
    max_active_rides_per_driver: 2,
    allow_same_direction_only: true,
    allow_new_ride_while_driver_active: true,
    max_pickup_detour_meters: 3000,
    max_dropoff_detour_meters: 5000,
  },
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data } = await supabase
      .from("global_dispatch_settings")
      .select("*")
      .eq("singleton", true)
      .maybeSingle();

    const payload = data
      ? {
          dispatch: {
            driver_response_timeout_seconds: Number(data.driver_response_timeout_seconds),
            start_radius_meters: Number(data.start_radius_meters),
            expand_radius_meters: Number(data.expand_radius_meters),
            max_radius_meters: Number(data.max_radius_meters),
            drivers_per_wave: Number(data.drivers_per_wave),
            wave_delay_seconds: Number(data.wave_delay_seconds),
            dispatch_mode: String(data.dispatch_mode ?? "smart_score"),
          },
          stacked_rides: {
            enabled: Boolean(data.stacked_rides_enabled),
            max_active_rides_per_driver: Number(data.max_active_rides_per_driver),
            allow_same_direction_only: Boolean(data.allow_same_direction_only),
            allow_new_ride_while_driver_active: Boolean(data.allow_new_ride_while_driver_active),
            max_pickup_detour_meters: Number(data.max_pickup_detour_meters),
            max_dropoff_detour_meters: Number(data.max_dropoff_detour_meters),
          },
        }
      : DEFAULTS;

    return new Response(JSON.stringify(payload), {
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=30" },
      status: 200,
    });
  } catch (err) {
    console.error("[dispatch-config] error", err);
    // Always return safe defaults — never break mobile apps
    return new Response(JSON.stringify(DEFAULTS), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  }
});
