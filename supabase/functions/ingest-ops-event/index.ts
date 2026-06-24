import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const DRIVER_EVENTS = new Set([
  "driver_accept_timeout",
  "driver_accept_false_timeout",
  "driver_offer_chips_late",
  "driver_offer_flicker",
  "driver_stacked_accept_timeout",
  "driver_arrive_slow",
  "driver_start_slow",
  "driver_complete_slow",
  "driver_map_marker_stuck",
  "driver_recenter_failed",
  "driver_zoom_control_failed",
  "driver_self_signout",
  "driver_ghost_notification",
]);

const CUSTOMER_EVENTS = new Set([
  "customer_active_trip_flash",
  "customer_white_screen",
  "customer_call_mask_failed",
  "customer_signup_email_failed",
  "customer_phone_verification_order_violation",
]);

const BACKEND_EVENTS = new Set([
  "contradictory_trip_state",
  "rematch_assignment_failed",
  "call_masking_provider_failed",
  "offer_presets_missing",
  "dispatch_timeout_exceeded",
]);

const ALL_EVENTS = new Set([...DRIVER_EVENTS, ...CUSTOMER_EVENTS, ...BACKEND_EVENTS]);

const VALID_APPS = new Set(["driver_app", "customer_app", "backend", "admin_panel"]);

type WorkflowEventPayload = {
  event_type: string;
  app_name: string;
  severity?: string;
  trip_id?: string | null;
  driver_id?: string | null;
  customer_id?: string | null;
  error_code?: string | null;
  duration_ms?: number | null;
  app_version?: string | null;
  platform?: string | null;
  device_model?: string | null;
  os_version?: string | null;
  session_id?: string | null;
  message?: string | null;
  metadata?: Record<string, unknown>;
  create_alert?: boolean;
};

function isUuid(v: unknown): v is string {
  return typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function expectedApp(eventType: string): string {
  if (DRIVER_EVENTS.has(eventType)) return "driver_app";
  if (CUSTOMER_EVENTS.has(eventType)) return "customer_app";
  return "backend";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ success: true, ingested: 0, note: "empty_body" });
    }

    const events: WorkflowEventPayload[] = Array.isArray(body)
      ? body
      : (body as { events?: WorkflowEventPayload[] })?.events ?? [body as WorkflowEventPayload];

    if (events.length === 0) {
      return json({ success: true, ingested: 0 });
    }

    const ingested: string[] = [];
    const errors: string[] = [];

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (!e?.event_type || !ALL_EVENTS.has(e.event_type)) {
        errors.push(`Event ${i}: invalid event_type "${e?.event_type}"`);
        continue;
      }

      const appName = e.app_name || expectedApp(e.event_type);
      if (!VALID_APPS.has(appName)) {
        errors.push(`Event ${i}: invalid app_name "${appName}"`);
        continue;
      }

      if (e.trip_id && !isUuid(e.trip_id)) {
        errors.push(`Event ${i}: invalid trip_id`);
        continue;
      }
      if (e.driver_id && !isUuid(e.driver_id)) {
        errors.push(`Event ${i}: invalid driver_id`);
        continue;
      }
      if (e.customer_id && !isUuid(e.customer_id)) {
        errors.push(`Event ${i}: invalid customer_id`);
        continue;
      }

      const severity = e.severity ?? "warning";
      const { data: eventId, error } = await supabase.rpc("ops_ingest_workflow_event", {
        p_event_type: e.event_type,
        p_app_name: appName,
        p_severity: severity,
        p_trip_id: e.trip_id ?? null,
        p_driver_id: e.driver_id ?? null,
        p_customer_id: e.customer_id ?? null,
        p_error_code: e.error_code ?? null,
        p_duration_ms: e.duration_ms ?? null,
        p_app_version: e.app_version ?? null,
        p_platform: e.platform ?? null,
        p_device_model: e.device_model ?? null,
        p_os_version: e.os_version ?? null,
        p_session_id: e.session_id ?? null,
        p_message: e.message ?? null,
        p_metadata: e.metadata ?? {},
        p_create_alert: e.create_alert !== false,
      });

      if (error) {
        errors.push(`Event ${i}: ${error.message}`);
        continue;
      }
      ingested.push(eventId as string);
    }

    return json({
      success: errors.length === 0 || ingested.length > 0,
      ingested: ingested.length,
      event_ids: ingested,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
