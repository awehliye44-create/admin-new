import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertServiceRole } from "../_shared/internalAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const gate = assertServiceRole(req);
  if (gate) return gate;

  try {

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Step 1: Auto-resolve stale alerts and align with real-time metrics
    const { data: resolveData, error: resolveError } = await supabase.rpc(
      "ops_auto_resolve_stale_alerts",
      { max_age_hours: 6 }
    );
    if (resolveError) console.error("auto-resolve error:", resolveError);

    // Step 2: Run all detection functions to find new issues
    const { data, error } = await supabase.rpc("ops_run_all_detections");
    if (error) throw error;

    return new Response(
      JSON.stringify({
        success: true,
        results: data,
        auto_resolved: resolveData,
        triggered_at: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("ops-run-detections error:", e);
    return new Response(
      JSON.stringify({ success: false, error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
