/**
 * #110 — Critical-path instrumentation lock.
 * Observability only; never weakens financial persistence.
 *
 * Run: deno test --allow-read supabase/tests/_shared/criticalPathPerf110Lock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyPerfOutcome,
  deriveCompleteTripDurations,
  emitCriticalPathPerfLog,
  sanitizePerfFields,
} from "../../functions/_shared/criticalPathPerfSSOT.ts";

Deno.test("sanitizePerfFields strips tokens and coordinates", () => {
  const cleaned = sanitizePerfFields({
    trip_id: "t1",
    access_token: "sbp_secret",
    driver_lat: 51.5,
    action: "complete_trip",
  });
  assertEquals(cleaned.trip_id, "t1");
  assertEquals(cleaned.action, "complete_trip");
  assertEquals("access_token" in cleaned, false);
  assertEquals("driver_lat" in cleaned, false);
});

Deno.test("deriveCompleteTripDurations uses monotonic stage marks", () => {
  const d = deriveCompleteTripDurations({
    complete_case_enter: 10,
    payment_gate_start: 20,
    payment_gate_end: 45,
    completion_writes_start: 100,
    completion_writes_end: 900,
    tip_window_persist_start: 950,
    tip_window_persist_end: 1800,
    pending_entitlement_start: 1810,
    pending_entitlement_end: 2000,
    response_ready: 2100,
  });
  assertEquals(d.payment_gate_ms, 25);
  assertEquals(d.completion_writes_ms, 800);
  assertEquals(d.tip_window_persist_ms, 850);
  assertEquals(d.pending_entitlement_ms, 190);
  assertEquals(d.completed_at_to_pending_ms, 1100);
  assertEquals(d.complete_case_to_response_ms, 2090);
  assertEquals(d.waiting_finalize_ms, null);
});

Deno.test("classifyPerfOutcome maps timeout/failure/success", () => {
  assertEquals(classifyPerfOutcome({ success: true }), "success");
  assertEquals(classifyPerfOutcome({ success: false }), "failure");
  assertEquals(classifyPerfOutcome({ success: true, timeout: true }), "timeout");
});

Deno.test("emitCriticalPathPerfLog is sync console-only", () => {
  emitCriticalPathPerfLog({
    event: "critical_path_perf",
    source: "stop-workflow",
    workflow_action: "complete_trip",
    request_id: "r1",
    correlation_id: "c1",
    trip_id: "t1",
    platform: "edge",
    runtime_version: null,
    ota_update_id: null,
    outcome: "success",
    total_ms: 100,
    stages_ms: {},
    durations_ms: {},
    parallel_groups: ["completion_writes"],
    notes: [],
  });
});

Deno.test("stop-workflow complete path marks tip persist + pending + PERF log", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/stop-workflow/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "emitCriticalPathPerfLog");
  assertStringIncludes(src, "deriveCompleteTripDurations");
  assertStringIncludes(src, "tip_window_persist_start");
  assertStringIncludes(src, "pending_entitlement_start");
  assertStringIncludes(src, "payment_gate_start");
  assertStringIncludes(src, "tip_area_read_start");
  assertStringIncludes(src, "critical_path_perf");
  // Durable pending remains awaited — never best-effort.
  assertStringIncludes(src, "await postPendingEntitlement");
});

Deno.test("criticalPathPerfSSOT lives in _shared and has no DB writes", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/criticalPathPerfSSOT.ts", import.meta.url),
  );
  assertEquals(src.includes("from("), false);
  assertEquals(src.includes("opsLog"), false);
  assertStringIncludes(src, "console.log");
});
