/** Wall-clock timing for edge function observability (duration_ms in responses + logs). */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  EDGE_FUNCTION_PERF_ACTION,
  evaluatePerformanceStatus,
  P95_TARGET_MS,
  timeoutBudgetForAction,
  type PerformanceStatus,
} from "../../../shared/performanceHealthControl.ts";
import { opsLog } from "./opsLog.ts";

export function startRequestTimer(): () => number {
  const t0 = performance.now();
  return () => Math.round(performance.now() - t0);
}

export function createRequestId(): string {
  return crypto.randomUUID();
}

export type EdgePerformanceMeta = {
  request_id: string;
  server_duration_ms: number;
  performance_status: PerformanceStatus;
  p95_target_ms: number;
  timeout_budget_ms: number;
  action_name: string;
};

export function resolveEdgePerformance(
  source: string,
  durationMs: number,
  success = true,
  requestId?: string,
): EdgePerformanceMeta | null {
  const action = EDGE_FUNCTION_PERF_ACTION[source];
  if (!action) return null;
  const p95_target_ms = P95_TARGET_MS[action];
  const timeout_budget_ms = timeoutBudgetForAction(action);
  const performance_status = evaluatePerformanceStatus({
    duration_ms: durationMs,
    p95_target_ms,
    timeout_budget_ms,
    success,
  });
  return {
    request_id: requestId ?? crypto.randomUUID(),
    server_duration_ms: durationMs,
    performance_status,
    p95_target_ms,
    timeout_budget_ms,
    action_name: action,
  };
}

export function logRequestDuration(
  label: string,
  durationMs: number,
  fields?: Record<string, unknown>,
): void {
  const perf = resolveEdgePerformance(
    label,
    durationMs,
    fields?.http_status == null || Number(fields.http_status) < 500,
    typeof fields?.request_id === "string" ? fields.request_id : undefined,
  );
  console.log(`[${label}] REQUEST_COMPLETE`, {
    duration_ms: durationMs,
    server_duration_ms: durationMs,
    ...fields,
    ...(perf
      ? {
        performance_status: perf.performance_status,
        p95_target_ms: perf.p95_target_ms,
        timeout_budget_ms: perf.timeout_budget_ms,
        action_name: perf.action_name,
      }
      : {}),
  });
}

export function withDuration<T extends Record<string, unknown>>(
  payload: T,
  durationMs: number,
  options?: { source?: string; success?: boolean; requestId?: string },
): T & {
  duration_ms: number;
  server_duration_ms: number;
  request_id?: string;
  performance_status?: PerformanceStatus;
  p95_target_ms?: number;
  timeout_budget_ms?: number;
} {
  const base = {
    ...payload,
    duration_ms: durationMs,
    server_duration_ms: durationMs,
  };
  if (!options?.source) return base;
  const perf = resolveEdgePerformance(
    options.source,
    durationMs,
    options.success ?? true,
    options.requestId,
  );
  if (!perf) return base;
  return {
    ...base,
    request_id: perf.request_id,
    performance_status: perf.performance_status,
    p95_target_ms: perf.p95_target_ms,
    timeout_budget_ms: perf.timeout_budget_ms,
  };
}

/** Fire-and-forget ops log + app_performance_events for driver backend edges. */
export function finishEdgeRequestLog(
  source: string,
  durationMs: number,
  fields?: Record<string, unknown>,
): void {
  const success = fields?.http_status == null || Number(fields.http_status) < 500;
  const requestId = typeof fields?.request_id === "string" ? fields.request_id : createRequestId();
  const perf = resolveEdgePerformance(source, durationMs, success, requestId);
  if (!perf) return;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) return;

  const client = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  void opsLog(client, {
    level: perf.performance_status !== "OK" && perf.performance_status !== "FAILED" ? "warn" : "info",
    source,
    app: "driver_app",
    message: `${source} completed in ${durationMs}ms`,
    duration_ms: durationMs,
    trip_id: typeof fields?.trip_id === "string" ? fields.trip_id : null,
    error_code: perf.performance_status,
    metadata: {
      request_id: requestId,
      flow_type: "backend_edge",
      ...perf,
      ...fields,
    },
  });

  void client.from("app_performance_events").insert({
    app_name: "admin_web",
    screen_name: perf.action_name,
    metric_name: "transaction_time",
    metric_value: durationMs,
    unit: "ms",
    platform: "edge",
    metadata: {
      action_name: perf.action_name,
      flow_type: "backend_edge",
      performance_status: perf.performance_status,
      p95_target_ms: perf.p95_target_ms,
      timeout_budget_ms: perf.timeout_budget_ms,
      request_id: requestId,
      edge_source: source,
      ...fields,
    },
  }).then(({ error }) => {
    if (error) console.warn(`[${source}] app_performance_events insert failed:`, error.message);
  });
}
