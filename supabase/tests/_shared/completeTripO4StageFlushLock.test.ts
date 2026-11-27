/**
 * B4-0 / O4 — Complete Trip stage flush + error-path instrumentation lock.
 *
 * Observability only. Never weakens financial completion / tip-window / PENDING.
 *
 * Run: deno test --allow-read supabase/tests/_shared/completeTripO4StageFlushLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  COMPLETE_TRIP_LIFECYCLE_ANCHORS,
  flushCompleteTripO4Stages,
  mergeCompleteTripLifecycleAnchors,
} from "../../functions/stop-workflow/lib/completeTripO4StageFlush.ts";
import { deriveCompleteTripDurations } from "../../functions/_shared/criticalPathPerfSSOT.ts";

Deno.test("O4 flush merges lifecycle anchors without overwriting complete marks", () => {
  const merged = mergeCompleteTripLifecycleAnchors(
    { complete_case_enter: 40, response_ready: 900 },
    {
      edge_receive: 1,
      auth_start: 2,
      auth_end: 12,
      reads_start: 15,
      reads_end: 35,
      // Must not overwrite if already present.
      complete_case_enter: 999,
    } as Record<string, number>,
  );
  assertEquals(merged.edge_receive, 1);
  assertEquals(merged.auth_end, 12);
  assertEquals(merged.complete_case_enter, 40);
  assertEquals(merged.response_ready, 900);
  for (const key of COMPLETE_TRIP_LIFECYCLE_ANCHORS) {
    assertEquals(typeof merged[key], "number");
  }
});

Deno.test("O4 flush derives B4-0 pre-case + respond_ok durations", () => {
  const flushed = flushCompleteTripO4Stages({
    completeStages: {
      complete_case_enter: 40,
      response_ready: 900,
      respond_ok_enter: 905,
      respond_ok_end: 920,
    },
    lifecycleStages: {
      edge_receive: 1,
      auth_end: 12,
    },
    exitMark: "error_settlement_failed",
    exitAtMs: 950,
  });
  assertEquals(flushed.stages_ms.edge_receive, 1);
  assertEquals(flushed.stages_ms.error_settlement_failed, 950);
  const d = flushed.complete_trip_durations_ms;
  assertEquals(d.edge_receive_to_auth_end_ms, 11);
  assertEquals(d.auth_to_case_enter_ms, 28);
  assertEquals(d.respond_ok_ms, 15);
  assertEquals(d.response_ready_to_respond_ok_end_ms, 20);
});

Deno.test("deriveCompleteTripDurations exposes new B4-0 pairs", () => {
  const d = deriveCompleteTripDurations({
    edge_receive: 0,
    auth_end: 50,
    complete_case_enter: 80,
    response_ready: 1000,
    respond_ok_enter: 1005,
    respond_ok_end: 1020,
  });
  assertEquals(d.edge_receive_to_auth_end_ms, 50);
  assertEquals(d.auth_to_case_enter_ms, 30);
  assertEquals(d.respond_ok_ms, 15);
});

Deno.test("stop-workflow publishes O4 stages on complete_trip error + success paths", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/stop-workflow/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "flushCompleteTripO4Stages");
  assertStringIncludes(src, "publishCompleteTripO4");
  assertStringIncludes(src, "completeTripError");
  assertStringIncludes(src, "respond_ok_enter");
  assertStringIncludes(src, "respond_ok_end");
  assertStringIncludes(src, "complete_trip_outcome");
  assertStringIncludes(src, "stopWorkflowCompleteStagesMs");
  // Error-path finishEdgeRequestLog retains stages for stalls/failures.
  assertStringIncludes(src, "complete_trip_outcome: \"failure\"");
  // Financial safeguards unchanged.
  assertStringIncludes(src, "PENDING_ENTITLEMENT_FAILED");
  assertStringIncludes(src, "payment_capture_deferred");
  assertEquals(src.includes("complete_trip_atomic"), false);
});

Deno.test("O4 flush helper is pure (no I/O)", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../functions/stop-workflow/lib/completeTripO4StageFlush.ts",
      import.meta.url,
    ),
  );
  assertEquals(src.includes("from("), false);
  assertEquals(src.includes("fetch("), false);
  assertEquals(src.includes("Deno."), false);
});
