import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface TelemetryEvent {
  app_name: string;
  screen_name: string;
  metric_name: string;
  metric_value: number;
  unit?: string;
  app_version?: string;
  platform?: string;
  device_model?: string;
  os_version?: string;
  user_id?: string;
  session_id?: string;
  metadata?: Record<string, unknown>;
}

const VALID_APPS = ["customer_app", "driver_app", "guest_web", "admin_web", "admin_panel", "corporate_web"];
const VALID_METRICS = [
  "screen_load_time",
  "api_latency",
  "transaction_time",
  "ttfb",
  "render_time",
  "interaction_delay",
  "network_request_time",
];

// Cost optimization: minimum thresholds to filter noise (values in ms)
const MIN_THRESHOLDS: Record<string, number> = {
  screen_load_time: 500,    // Only store slow loads (>500ms)
  api_latency: 300,         // Only store slow API calls (>300ms)
  render_time: 200,         // Only store slow renders (>200ms)
  ttfb: 400,                // Only store slow TTFB (>400ms)
  network_request_time: 500, // Only store slow network (>500ms)
  // transaction_time and interaction_delay: always store (important flows)
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid JSON body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (body === null || body === undefined || (typeof body === "object" && !Array.isArray(body) && Object.keys(body as Record<string, unknown>).length === 0)) {
      return new Response(
        JSON.stringify({ success: false, error: "events array is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const events: TelemetryEvent[] = Array.isArray(body) ? body : [body as TelemetryEvent];

    // Validate
    const valid: TelemetryEvent[] = [];
    const errors: string[] = [];

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (!e.app_name || !VALID_APPS.includes(e.app_name)) {
        errors.push(`Event ${i}: invalid app_name "${e.app_name}"`);
        continue;
      }
      if (!e.screen_name || typeof e.screen_name !== "string") {
        errors.push(`Event ${i}: missing screen_name`);
        continue;
      }
      if (!e.metric_name || !VALID_METRICS.includes(e.metric_name)) {
        errors.push(`Event ${i}: invalid metric_name "${e.metric_name}"`);
        continue;
      }
      if (typeof e.metric_value !== "number" || e.metric_value < 0) {
        errors.push(`Event ${i}: invalid metric_value`);
        continue;
      }
      // Cost optimization: drop fast/healthy events to reduce storage
      const threshold = MIN_THRESHOLDS[e.metric_name];
      if (threshold !== undefined && e.metric_value < threshold) {
        continue; // Below threshold — healthy, no need to store
      }
      valid.push(e);
    }

    if (valid.length === 0) {
      return new Response(
        JSON.stringify({ success: false, errors }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const rows = valid.map((e) => ({
      app_name: e.app_name,
      screen_name: e.screen_name,
      metric_name: e.metric_name,
      metric_value: e.metric_value,
      unit: e.unit || "ms",
      app_version: e.app_version || null,
      platform: e.platform || null,
      device_model: e.device_model || null,
      os_version: e.os_version || null,
      user_id: e.user_id || null,
      session_id: e.session_id || null,
      metadata: e.metadata || {},
    }));

    const { error } = await supabase
      .from("app_performance_events")
      .insert(rows);

    if (error) throw error;

    return new Response(
      JSON.stringify({
        success: true,
        ingested: valid.length,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ success: false, error: e.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
