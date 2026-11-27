/**
 * #110 — Critical-path performance instrumentation SSOT.
 *
 * Observability only. Monotonic elapsed marks → structured console log.
 * Never writes to the database on the request path.
 * Never logs tokens, payment credentials, or precise location.
 */

export type CriticalPathOutcome = "success" | "failure" | "timeout";

export type CriticalPathPerfEvent = {
  event: "critical_path_perf";
  source: string;
  workflow_action: string;
  request_id: string;
  correlation_id: string | null;
  trip_id: string | null;
  platform: string;
  runtime_version: string | null;
  ota_update_id: string | null;
  outcome: CriticalPathOutcome;
  total_ms: number;
  stages_ms: Record<string, number>;
  durations_ms: Record<string, number | null>;
  parallel_groups: string[];
  notes: string[];
};

const FORBIDDEN_KEY = /token|password|secret|authorization|cvv|pan|card_number|email|phone|lat|lng|latitude|longitude|accuracy/i;

export function sanitizePerfFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (FORBIDDEN_KEY.test(k)) continue;
    if (typeof v === "string" && v.length > 256) {
      out[k] = v.slice(0, 256);
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function deriveNamedStageDurations(
  stages: Record<string, number>,
  pairs: ReadonlyArray<readonly [string, string, string]>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [name, start, end] of pairs) {
    const a = stages[start];
    const b = stages[end];
    out[name] =
      typeof a === "number" && typeof b === "number" ? Math.max(0, b - a) : null;
  }
  return out;
}

/** Complete-trip awaited spans (ms from request start marks). */
export const COMPLETE_TRIP_DURATION_PAIRS = [
  ["payment_gate_ms", "payment_gate_start", "payment_gate_end"],
  ["waiting_finalize_ms", "waiting_finalize_start", "waiting_finalize_end"],
  ["fare_lookup_ms", "fare_lookup_start", "fare_lookup_end"],
  ["tip_order_lookup_ms", "tip_order_lookup_start", "tip_order_lookup_end"],
  ["tip_area_read_ms", "tip_area_read_start", "tip_area_read_end"],
  ["completion_writes_ms", "completion_writes_start", "completion_writes_end"],
  ["settlement_cpu_ms", "settlement_start", "settlement_end"],
  [
    "tip_window_persist_ms",
    "tip_window_persist_start",
    "tip_window_persist_end",
  ],
  [
    "tip_window_reselect_ms",
    "tip_window_reselect_start",
    "tip_window_reselect_end",
  ],
  [
    "pending_entitlement_ms",
    "pending_entitlement_start",
    "pending_entitlement_end",
  ],
  [
    "capture_requested_stamp_ms",
    "capture_requested_stamp_start",
    "capture_requested_stamp_end",
  ],
  ["payment_capture_block_ms", "payment_capture_start", "payment_capture_end"],
  ["wallet_ledger_ms", "wallet_ledger_start", "wallet_ledger_end"],
  [
    "complete_case_to_response_ms",
    "complete_case_enter",
    "response_ready",
  ],
  [
    "completed_at_to_pending_ms",
    "completion_writes_end",
    "pending_entitlement_end",
  ],
  // B4-0 / O4 — pre-case + respondOk delivery (lifecycle anchors merged into map).
  ["edge_receive_to_auth_end_ms", "edge_receive", "auth_end"],
  ["auth_to_case_enter_ms", "auth_end", "complete_case_enter"],
  ["respond_ok_ms", "respond_ok_enter", "respond_ok_end"],
  [
    "response_ready_to_respond_ok_end_ms",
    "response_ready",
    "respond_ok_end",
  ],
] as const;

export function deriveCompleteTripDurations(
  stages: Record<string, number>,
): Record<string, number | null> {
  return deriveNamedStageDurations(stages, COMPLETE_TRIP_DURATION_PAIRS);
}

/**
 * Structured critical-path log. Console only — no awaited I/O.
 * Existing finishEdgeRequestLog remains the durable fire-and-forget sink.
 */
export function emitCriticalPathPerfLog(
  event: CriticalPathPerfEvent,
): void {
  console.log(
    "[critical_path_perf]",
    JSON.stringify(
      sanitizePerfFields(event as unknown as Record<string, unknown>),
    ),
  );
}

export function classifyPerfOutcome(input: {
  success: boolean;
  timeout?: boolean;
}): CriticalPathOutcome {
  if (input.timeout) return "timeout";
  return input.success ? "success" : "failure";
}
