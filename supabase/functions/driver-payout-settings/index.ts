import { createClient } from "npm:@supabase/supabase-js@2";
import { buildDriverPayoutSettingsPayload } from "../_shared/buildDriverPayoutSettingsPayload.ts";
import { resolveAuthenticatedDriver } from "../_shared/resolveAuthenticatedDriver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const resolved = await resolveAuthenticatedDriver(supabase, user.id, "PAYOUT_SETTINGS");
    if (!resolved.ok) {
      const status =
        resolved.reason === "auth_user_missing" ? 401
        : resolved.reason === "rls_denied" ? 403
        : 404;
      return new Response(
        JSON.stringify({ error: resolved.reason, message: resolved.message }),
        { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const driver = resolved.driver;
    const { data: driverRow } = await supabase
      .from("drivers")
      .select("service_area_id, region_id")
      .eq("id", driver.driver_id)
      .maybeSingle();

    const payload = await buildDriverPayoutSettingsPayload(supabase, {
      driverId: driver.driver_id,
      serviceAreaId: driverRow?.service_area_id ?? null,
      driver: {
        region_id: driverRow?.region_id ?? null,
      },
    });

    return new Response(JSON.stringify({ success: true, ...payload }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("DRIVER_PAYOUT_SETTINGS_FAILED", error);
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
