// ONECAB Telemetry Ingestion — v12 (best-effort outage isolation)
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { checkRateLimit, getClientIP } from "../_shared/security.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MAX_BODY_BYTES = 65_536;
const MAX_EVENTS_PER_REQUEST = 50;
/** Book tap → Finding residual closure needs many flat segment keys. */
const MAX_METADATA_KEYS = 80;
const MAX_METADATA_VALUE_LEN = 256;
const MAX_SCREEN_NAME_LEN = 120;

/** Flat keys only — nested objects are dropped. Book→Finding segments are scalars. */
const ALLOWED_METADATA_KEYS = new Set([
  "endpoint",
  "method",
  "status_code",
  "error_code",
  "phase",
  "route",
  "action",
  "provider",
  "attempt",
  "duration_ms",
  "cache_hit",
  "network_type",
  // Book tap → Finding (customer_booking_to_active_screen)
  "outcome",
  "performance_status",
  "p95_target_ms",
  "goal_p95_ms",
  "booking_path",
  "tap_to_busy_ms",
  "busy_to_prep_ms",
  "saved_card_client_prep_ms",
  "busy_to_preauth_ms",
  "preauth_ms",
  "preauth_to_ui_ms",
  "apple_pay_present_ms",
  "apple_pay_user_interaction_ms",
  "apple_pay_return_to_app_ms",
  "google_pay_user_interaction_ms",
  "preauth_to_confirm_ms",
  "confirm_ms",
  "confirm_poll_iters",
  "confirm_poll_sleep_ms",
  "confirm_poll_request_ms",
  "confirm_to_ctap_ms",
  "confirm_to_settle_ms",
  "payment_authorisation_settle_ms",
  "settle_to_ctap_ms",
  "payment_settle_reason",
  "booking_edge_ms",
  "ctap_adopt_ms",
  "seed_to_nav_ms",
  "navigation_render_ms",
  "mounted_to_interactive_ms",
  "total_book_to_finding_ms",
  "external_payment_ui_ms",
  "onecab_processing_ms",
  "accounted_ms",
  "unaccounted_ms",
  "edge_preauth_server_ms",
  "edge_ctap_server_ms",
  "edge_preauth_revolut_ms",
  "edge_ctap_insert_ms",
  "edge_receive_to_auth_ms",
  "edge_auth_ms",
  "edge_db_lookup_ms",
  "edge_validation_ms",
  "edge_revolut_request_ms",
  "edge_revolut_response_ms",
  "edge_persist_ms",
  "edge_response_build_ms",
  "edge_total_ms",
  "already_authorised",
  "three_ds_required",
  // Driver Accept waterfall (client + Edge shared perf_id)
  "perf_id",
  "flow_type",
  "action_name",
  "offer_suffix",
  "accept_tap_to_busy_ms",
  "accept_pre_edge_ms",
  "accept_edge_rtt_ms",
  "accept_get_session_ms",
  "accept_auth_context_ms",
  "accept_fetch_ms",
  "accept_ttfb_ms",
  "accept_body_parse_ms",
  "accept_response_to_state_ms",
  "accept_state_to_interactive_ms",
  "accept_tap_to_interactive_ms",
  "edge_auth_ms",
  "edge_offer_lookup_ms",
  "edge_validation_ms",
  "edge_lock_ms",
  "edge_accept_rpc_ms",
  "edge_canonical_assignment_ms",
  "edge_post_trip_fetch_ms",
  "edge_post_driver_fetch_ms",
  "edge_booking_delivery_ms",
  "edge_response_build_ms",
  "edge_post_canonical_blocking_ms",
  "timeout_budget_ms",
  // Accept eligibility sub-stages (Phase 2)
  "eligibility_driver_load_ms",
  "eligibility_docs_rpc_ms",
  "eligibility_local_checks_ms",
  // Arrive waiting SSOT sub-stages (Phase 3)
  "waiting_ssot_total_ms",
  "waiting_trip_context_ms",
  "waiting_config_ms",
  "waiting_existing_state_ms",
  "waiting_canonical_rpc_ms",
  "waiting_geofence_ms",
  "waiting_post_canonical_ms",
  "edge_waiting_ssot_ms",
  "drive_next_waiting_finalize_rpc_ms",
  "drive_next_waiting_geofence_sync_ms",
  "drive_next_waiting_segment_close_ms",
  "drive_next_waiting_finalize_via",
  "start_waiting_finalize_rpc_ms",
  "start_waiting_geofence_final_ms",
  "start_waiting_segment_close_ms",
  "start_waiting_charge_calc_ms",
  "start_waiting_finalize_via",
  "stop_waiting_geofence_open_ms",
  "stop_waiting_segment_created",
  "stop_waiting_segment_id",
  "stop_waiting_segment_stop_id",
  "stop_waiting_geofence_skip_reason",
  "arrive_stop_gate_total_ms",
  "arrive_stop_handler_to_location_start_ms",
  "arrive_stop_location_resolve_ms",
  "arrive_stop_far_modal_user_ms",
  "arrive_stop_radius_check_ms",
  // Lifecycle CTA flat keys (Arrive / Start / Arrive Stop / Drive Next)
  "edge_rtt_ms",
  "edge_server_ms",
  "pre_edge_ms",
  "tap_to_gate_ms",
  "gps_gate_ms",
  "response_to_state_ms",
  "state_to_interactive_ms",
  "tap_to_interactive_ms",
  "gate_to_edge_start_ms",
  "response_to_state_seed_ms",
  "state_seed_to_interactive_ms",
  "next_leg_calc_ms",
  "route_fetch_ms",
  "cta",
  "trip_suffix",
  "trip_id",
  "driver_id",
  "edge_http_status",
  "edge_p0_ms",
  "app_version",
  "build_number",
  "native_build",
  "release_environment",
  // Complete → Rate flat stage keys
  "complete_gate_ms",
  "waiting_finalize_ms",
  "fare_ms",
  "completion_writes_ms",
  "payment_capture_ms",
  "state_to_rating_nav_ms",
  "rating_nav_to_mount_ms",
  "rating_mount_to_interactive_ms",
  "complete_tap_to_rating_ms",
  "far_gate_wall_ms",
  "far_gate_system_ms",
  "far_gps_refresh_ms",
  "far_modal_user_ms",
  "complete_edge_ms",
  "edge_to_rating_seeded_ms",
  "edge_to_active_trip_cleared_ms",
  "edge_to_rate_mounted_ms",
  // Go Online fast path (Phase 1)
  "go_online_path",
  "go_online_tap_to_interactive_ms",
  "go_online_permission_ms",
  "go_online_location_ms",
  "go_online_push_readiness_ms",
  "go_online_precanonical_ms",
  "go_online_rpc_ms",
  "go_online_canonical_confirmed_ms",
  "go_online_postcanonical_ms",
  "go_online_response_to_state_ms",
  "go_online_state_to_interactive_ms",
  "go_online_server_total_ms",
  "go_online_server_eligibility_ms",
  "go_online_server_presence_ms",
  "still_checking_shown",
  "still_checking_after_ms",
  // Wallet home open (Phase 1)
  "wallet_path",
  "wallet_tap_to_mount_ms",
  "wallet_balance_ms",
  "wallet_withdraw_quote_ms",
  "wallet_history_first_page_ms",
  "wallet_secondary_ms",
  "wallet_tap_to_first_useful_render_ms",
  "wallet_tap_to_interactive_ms",
  "network_request_count",
  "history_rows_returned",
  "stretch_target_ms",
  // Earnings home open (Phase 1)
  "earnings_path",
  "earnings_tap_to_mount_ms",
  "earnings_rows_ms",
  "earnings_summary_ms",
  "earnings_online_ms",
  "earnings_tap_to_first_useful_render_ms",
  "earnings_tap_to_interactive_ms",
  "earnings_chart_ready_ms",
  "earnings_recent_ready_ms",
  "earning_rows_returned",
  "recent_rows_rendered",
  "system_complete_to_rate_ms",
  "total_complete_to_rate_wall_ms",
  "reconcile_hydrate_ms",
  "client_action_id",
  "workflow_type",
  "far_gate_outcome",
  // Rating → Home
  "rating_tap_to_home_interactive_ms",
  "rating_submit_to_canonical_ms",
  "canonical_to_home_nav_ms",
  "home_nav_to_mount_ms",
  "home_mount_to_interactive_ms",
  // restore-active-trip observability (safe ids only)
  "trigger",
  "reason",
  "cold_start_hint",
  "restore_trigger",
  "restore_reason",
  "restore_request_start",
  "restore_response",
  "restore_seed_applied",
  "known_trip_id_sent",
  "restore_auth_ms",
  "restore_identity_ms",
  "restore_trip_ms",
  "restore_stops_ms",
  "restore_driver_ms",
  "restore_waiting_ms",
  "restore_secondary_ms",
  "restore_response_ms",
  "restore_edge_total_ms",
  "restore_known_trip_id",
  "restore_known_trip_hit",
  // Customer foreground active-trip recovery (T0→T9)
  "recovery_id",
  "recovery_kind",
  "last_mark",
  "foreground_detected",
  "cached_trip_present",
  "cached_trip_status",
  "persisted_seed_present",
  "reconcile_start",
  "restore_start",
  "restore_edge_receive",
  "restore_edge_response",
  "restore_client_receive",
  "canonical_apply",
  "navigation_decision",
  "active_screen_mount",
  "active_screen_useful",
  "active_screen_interactive",
  "t0_to_useful_ms",
  "t0_to_interactive_ms",
]);

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

interface TelemetryPayload {
  events?: TelemetryEvent[];
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
  screen_load_time: 500,
  api_latency: 300,
  render_time: 200,
  ttfb: 400,
  network_request_time: 500,
};

function sanitizeMetadata(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_METADATA_KEYS) break;
    if (!ALLOWED_METADATA_KEYS.has(key)) continue;
    if (typeof value === "string") {
      out[key] = value.slice(0, MAX_METADATA_VALUE_LEN);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ success: false, error: "Payload too large" }), {
      status: 413,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const rate = checkRateLimit(getClientIP(req), {
    keyPrefix: "ingest-telemetry",
    limit: 120,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return new Response(JSON.stringify({ success: false, error: "Rate limited" }), {
      status: 429,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const rawText = await req.text();
    if (rawText.length > MAX_BODY_BYTES) {
      return new Response(JSON.stringify({ success: false, error: "Payload too large" }), {
        status: 413,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let body: unknown;
    try {
      body = rawText ? JSON.parse(rawText) : null;
    } catch {
      // Empty body or invalid JSON — treat as no-op success
      return new Response(
        JSON.stringify({ success: true, ingested: 0, note: "empty_or_invalid_body" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Handle null, undefined, empty object — graceful no-op
    if (body === null || body === undefined) {
      return new Response(
        JSON.stringify({ success: true, ingested: 0, note: "null_body" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Handle empty object {} — graceful no-op
    if (typeof body === "object" && !Array.isArray(body) && Object.keys(body as Record<string, unknown>).length === 0) {
      return new Response(
        JSON.stringify({ success: true, ingested: 0, note: "empty_object" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const wrappedEvents =
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      Array.isArray((body as TelemetryPayload).events)
        ? (body as TelemetryPayload).events ?? []
        : null;

    const events: TelemetryEvent[] = Array.isArray(body)
      ? body
      : wrappedEvents ?? [body as TelemetryEvent];

    if (events.length > MAX_EVENTS_PER_REQUEST) {
      return new Response(
        JSON.stringify({ success: false, error: "Too many events in one request" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Empty array — graceful no-op (not an error)
    if (events.length === 0) {
      return new Response(
        JSON.stringify({ success: true, ingested: 0, note: "empty_array" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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
      if (e.screen_name.length > MAX_SCREEN_NAME_LEN) {
        errors.push(`Event ${i}: screen_name too long`);
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

    // All events filtered out (below threshold or invalid) — graceful success
    if (valid.length === 0) {
      return new Response(
        JSON.stringify({ success: true, ingested: 0, filtered: events.length, errors: errors.length > 0 ? errors : undefined }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const rows = valid.map((e) => ({
      app_name: e.app_name,
      screen_name: e.screen_name.slice(0, MAX_SCREEN_NAME_LEN),
      metric_name: e.metric_name,
      metric_value: e.metric_value,
      unit: e.unit || "ms",
      app_version: e.app_version?.slice(0, 32) || null,
      platform: e.platform?.slice(0, 32) || null,
      device_model: e.device_model?.slice(0, 64) || null,
      os_version: e.os_version?.slice(0, 32) || null,
      user_id: null,
      session_id: typeof e.session_id === "string" ? e.session_id.slice(0, 64) : null,
      metadata: sanitizeMetadata(e.metadata),
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
    // Telemetry must never become an application failure. In particular, do not
    // reflect database/gateway HTML (for example a Cloudflare 522 page) back to
    // callers. The client deliberately drops this batch and applies a cooldown.
    console.error("ingest-telemetry storage unavailable", {
      error_code: "TELEMETRY_STORAGE_UNAVAILABLE",
      error_name: e instanceof Error ? e.name : "UnknownError",
    });
    return new Response(
      JSON.stringify({
        success: false,
        ingested: 0,
        error_code: "TELEMETRY_STORAGE_UNAVAILABLE",
        retryable: true,
      }),
      {
        status: 202,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Retry-After": "60",
        },
      },
    );
  }
});