import { createClient } from "npm:@supabase/supabase-js@2.57.2";

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
    // Validate auth
    const authHeader = req.headers.get("authorization") ?? "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } }
    );

    const url = new URL(req.url);
    const appName = url.searchParams.get("app_name") || "customer_app";
    const hours = Math.min(parseInt(url.searchParams.get("hours") || "24"), 720);

    // Use the P95 database function
    const { data, error } = await supabase.rpc("get_performance_p95", {
      p_app_name: appName,
      p_hours: hours,
    });

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build summary
    const screens = (data || []).map((row: Record<string, unknown>) => ({
      screen_name: row.screen_name,
      total_events: row.total_events,
      p95_ms: Math.round(row.p95_ms as number),
      avg_ms_reference_only: Math.round(row.avg_ms as number),
      min_ms: Math.round(row.min_ms as number),
      max_ms: Math.round(row.max_ms as number),
      health_status: row.health_status,
      threshold: {
        warning: row.warning_threshold,
        critical: row.critical_threshold,
      },
    }));

    const criticalCount = screens.filter((s: { health_status: string }) => s.health_status === "CRITICAL").length;
    const warningCount = screens.filter((s: { health_status: string }) => s.health_status === "WARNING").length;

    return new Response(
      JSON.stringify({
        measurement: "P95 (95th percentile)",
        note: "All health statuses and alerts are based on P95. AVG is shown as reference only.",
        period_hours: hours,
        app_name: appName,
        go_live_ready: criticalCount === 0 && warningCount === 0,
        summary: {
          total_screens: screens.length,
          healthy: screens.filter((s: { health_status: string }) => s.health_status === "HEALTHY").length,
          acceptable: screens.filter((s: { health_status: string }) => s.health_status === "ACCEPTABLE").length,
          warning: warningCount,
          critical: criticalCount,
        },
        screens,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
