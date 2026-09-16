// ONECAB Telemetry Ingestion — v11 (P2 abuse hardening — deploy separately from P0 SQL)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkRateLimit, getClientIP } from "../_shared/security.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MAX_BODY_BYTES = 65_536;
const MAX_EVENTS_PER_REQUEST = 50;
const MAX_METADATA_KEYS = 12;
const MAX_METADATA_VALUE_LEN = 256;
const MAX_SCREEN_NAME_LEN = 120;

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
    return new Response(
      JSON.stringify({ success: false, error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});