import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  EDGE_FUNCTION_PERF_ACTION,
  evaluatePerformanceStatus,
  P95_TARGET_MS,
  timeoutBudgetForAction,
  type PerformanceStatus,
} from "../../../shared/performanceHealthControl.ts";
import { opsLog } from "./opsLog.ts";

const warmInstances = new Set<string>();

export type EdgeTimingRecord = {
  source: string;
  requestId: string;
  startedAt: number;
  coldStartHint: boolean;
  path: string;
  clientActionId: string | null;
  httpStatus: number;
};

export type EdgePerformanceMeta = {
  action_name: string;
  server_duration_ms: number;
  p95_target_ms: number;
  timeout_budget_ms: number;
  performance_status: PerformanceStatus;
};

export function extractClientActionId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>).client_action_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function startEdgeTiming(source: string, path = "POST"): EdgeTimingRecord {
  const coldStartHint = !warmInstances.has(source);
  warmInstances.add(source);
  return {
    source,
    requestId: crypto.randomUUID(),
    startedAt: Date.now(),
    coldStartHint,
    path,
    clientActionId: null,
    httpStatus: 500,
  };
}

export async function tryReadClientActionId(req: Request, timer: EdgeTimingRecord): Promise<void> {
  try {
    const body = await req.clone().json();
    timer.clientActionId = extractClientActionId(body);
  } catch {
    /* no JSON body */
  }
}

export function resolveEdgePerformance(
  source: string,
  durationMs: number,
  success: boolean,
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
    action_name: action,
    server_duration_ms: durationMs,
    p95_target_ms,
    timeout_budget_ms,
    performance_status,
  };
}

export function logEdgeTimingConsole(timer: EdgeTimingRecord, perf: EdgePerformanceMeta | null): void {
  const duration_ms = Date.now() - timer.startedAt;
  console.log(JSON.stringify({
    edge_timing: timer.source,
    request_id: timer.requestId,
    duration_ms,
    server_duration_ms: duration_ms,
    path: timer.path,
    client_action_id: timer.clientActionId,
    cold_start_hint: timer.coldStartHint,
    http_status: timer.httpStatus,
    ...(perf
      ? {
        action_name: perf.action_name,
        p95_target_ms: perf.p95_target_ms,
        timeout_budget_ms: perf.timeout_budget_ms,
        performance_status: perf.performance_status,
      }
      : {}),
  }));
}

export async function finishEdgeTiming(
  adminClient: SupabaseClient | null,
  timer: EdgeTimingRecord,
): Promise<void> {
  const duration_ms = Date.now() - timer.startedAt;
  const success = timer.httpStatus < 500;
  const perf = resolveEdgePerformance(timer.source, duration_ms, success);
  logEdgeTimingConsole(timer, perf);
  if (!adminClient) return;

  const perfWarning = perf && perf.performance_status !== "OK" && perf.performance_status !== "FAILED";
  await opsLog(adminClient, {
    level: perfWarning || timer.httpStatus >= 500 ? "warn" : "info",
    source: timer.source,
    app: "customer_app",
    message: `${timer.source} ${timer.path} completed in ${duration_ms}ms`,
    duration_ms,
    http_status: timer.httpStatus,
    error_code: perf?.performance_status ?? null,
    metadata: {
      request_id: timer.requestId,
      path: timer.path,
      client_action_id: timer.clientActionId,
      cold_start_hint: timer.coldStartHint,
      flow_type: "backend_edge",
      ...(perf ?? {}),
    },
  });

  if (perf && adminClient) {
    try {
      await adminClient.from("app_performance_events").insert({
        app_name: "customer_app",
        screen_name: perf.action_name,
        metric_name: "transaction_time",
        metric_value: duration_ms,
        unit: "ms",
        platform: "edge",
        metadata: {
          action_name: perf.action_name,
          flow_type: "backend_edge",
          performance_status: perf.performance_status,
          p95_target_ms: perf.p95_target_ms,
          timeout_budget_ms: perf.timeout_budget_ms,
          request_id: timer.requestId,
          edge_source: timer.source,
          http_status: timer.httpStatus,
        },
      });
    } catch (err) {
      console.warn("[edgeFunctionTiming] app_performance_events insert failed:", err);
    }
  }
}

function attachTimingHeaders(
  response: Response,
  timer: EdgeTimingRecord,
  perf: EdgePerformanceMeta | null,
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Request-Id", timer.requestId);
  headers.set("X-Server-Duration-Ms", String(Date.now() - timer.startedAt));
  if (perf) {
    headers.set("X-Performance-Status", perf.performance_status);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createServiceRoleClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

/**
 * Wrap an edge handler with duration logging to console + ops_logs + app_performance_events.
 */
export function serveWithEdgeTiming(
  source: string,
  corsHeaders: Record<string, string>,
  handler: (req: Request) => Promise<Response>,
): void {
  Deno.serve(async (req) => {
    const adminClient = createServiceRoleClient();
    const timer = startEdgeTiming(source, req.method);

    try {
      if (req.method === "OPTIONS") {
        timer.httpStatus = 204;
        return new Response(null, { headers: corsHeaders });
      }

      timer.path = req.method || "POST";
      await tryReadClientActionId(req, timer);

      const response = await handler(req);
      timer.httpStatus = response.status;
      const duration_ms = Date.now() - timer.startedAt;
      const perf = resolveEdgePerformance(source, duration_ms, response.status < 500);
      return attachTimingHeaders(response, timer, perf);
    } catch (error) {
      timer.httpStatus = 500;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${source}] unhandled`, message);
      const errResponse = new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      const duration_ms = Date.now() - timer.startedAt;
      const perf = resolveEdgePerformance(source, duration_ms, false);
      return attachTimingHeaders(errResponse, timer, perf);
    } finally {
      // Never block the client on ops_logs / app_performance_events writes.
      void finishEdgeTiming(adminClient, timer);
    }
  });
}
