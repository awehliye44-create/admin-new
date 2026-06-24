import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

export type OpsLogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type OpsLogInput = {
  level: OpsLogLevel;
  source: string;
  app?: string;
  message: string;
  event_type?: string;
  error_code?: string;
  trip_id?: string | null;
  driver_id?: string | null;
  customer_id?: string | null;
  duration_ms?: number | null;
  http_status?: number | null;
  metadata?: Record<string, unknown>;
  /** When set, also creates workflow event + alert via ops_ingest_workflow_event */
  workflow_event_type?: string;
  severity?: "info" | "warning" | "critical" | "fatal";
};

const WORKFLOW_EVENT_TYPES = new Set([
  "contradictory_trip_state",
  "rematch_assignment_failed",
  "call_masking_provider_failed",
  "offer_presets_missing",
  "dispatch_timeout_exceeded",
]);

/**
 * Production ops log writer — inserts ops_logs and optionally workflow events.
 * Fire-and-forget; never throws to caller.
 */
export async function opsLog(
  client: SupabaseClient,
  input: OpsLogInput,
): Promise<void> {
  try {
    const metadata = {
      ...(input.metadata ?? {}),
      ...(input.event_type ? { event_type: input.event_type } : {}),
    };

    await client.from("ops_logs").insert({
      level: input.level,
      source: input.source,
      app: input.app ?? "backend",
      message: input.message,
      error_code: input.error_code ?? null,
      trip_id: input.trip_id ?? null,
      driver_id: input.driver_id ?? null,
      duration_ms: input.duration_ms ?? null,
      http_status: input.http_status ?? null,
      metadata,
      is_synthetic: false,
    });

    const workflowType = input.workflow_event_type ?? input.event_type;
    if (workflowType && WORKFLOW_EVENT_TYPES.has(workflowType)) {
      await client.rpc("ops_ingest_workflow_event", {
        p_event_type: workflowType,
        p_app_name: input.app ?? "backend",
        p_severity: input.severity ?? (input.level === "fatal" ? "fatal" : input.level === "error" ? "critical" : "warning"),
        p_trip_id: input.trip_id ?? null,
        p_driver_id: input.driver_id ?? null,
        p_customer_id: input.customer_id ?? null,
        p_error_code: input.error_code ?? null,
        p_duration_ms: input.duration_ms ?? null,
        p_message: input.message,
        p_metadata: metadata,
        p_create_alert: true,
      });
    }
  } catch (err) {
    console.error("[opsLog] failed:", err);
  }
}
