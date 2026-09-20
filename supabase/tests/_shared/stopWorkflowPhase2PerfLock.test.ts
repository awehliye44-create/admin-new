/**
 * Lock: stop-workflow Phase 2 — post-canonical notify/audit off Driver critical path.
 *
 * Notifications are NOT removed — scheduleEdgeBackground / waitUntil.
 * Waiting SSOT + payment capture stay on-path.
 *
 * Run: deno test --allow-read supabase/tests/_shared/stopWorkflowPhase2PerfLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const stopWorkflowPath = new URL(
  "../../functions/stop-workflow/index.ts",
  import.meta.url,
);
const bgPath = new URL(
  "../../functions/_shared/scheduleEdgeBackground.ts",
  import.meta.url,
);

Deno.test("scheduleEdgeBackground uses EdgeRuntime.waitUntil", async () => {
  const src = await Deno.readTextFile(bgPath);
  assertStringIncludes(src, "EdgeRuntime.waitUntil");
  assertStringIncludes(src, "scheduleEdgeBackground");
});

Deno.test("arrive_pickup moves driver_arrived notify off-path after waiting SSOT", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  assertStringIncludes(src, "scheduleEdgeBackground");
  assertStringIncludes(src, "arrive_pickup_p2");
  assertStringIncludes(src, "tryStartPickupWaiting");
  assertStringIncludes(src, "pickup_waiting_started_at missing after Arrived");
  assertStringIncludes(src, "skipSnapshotRefresh: true");
  // Notify is scheduled in the arrive_pickup_p2 background block (not removed).
  const p2Close = src.indexOf('arrive_pickup_p2');
  assertEquals(p2Close > 0, true);
  assertEquals(src.lastIndexOf("scheduleEdgeBackground", p2Close) > 0, true);
  assertEquals(src.lastIndexOf('event: "driver_arrived"', p2Close) > 0, true);
});

Deno.test("start_trip keeps waiting finalize on-path; audits+notify off-path", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  assertStringIncludes(src, "finalizePickupWaitingOnStartTrip");
  assertStringIncludes(src, "start_trip_p2");
  assertStringIncludes(src, 'event: "trip_started"');
  assertStringIncludes(src, "PICKUP_WAITING_FINALIZED");
  const startIdx = src.indexOf("case 'start_trip'");
  const startBlock = src.slice(startIdx, startIdx + 14000);
  const finalizeIdx = startBlock.indexOf("finalizePickupWaitingOnStartTrip");
  const notifyBgIdx = startBlock.indexOf("start_trip_p2");
  assertEquals(finalizeIdx > 0 && notifyBgIdx > finalizeIdx, true);
  // Waiting finalize audits must live inside start_trip_p2 waitUntil, not before mutation return.
  const p2Block = startBlock.slice(
    startBlock.lastIndexOf("scheduleEdgeBackground", notifyBgIdx),
    notifyBgIdx + 80,
  );
  assertEquals(p2Block.includes("PICKUP_WAITING_FINALIZED"), true);
});

Deno.test("drive_to_next keeps waiting finalize on-path; tap/finalize audits off-path", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  assertStringIncludes(src, "finalizeStopWaitingCharge");
  assertStringIncludes(src, "drive_to_next_p2");
  const driveIdx = src.indexOf("case 'drive_to_next'");
  const driveBlock = src.slice(driveIdx, driveIdx + 12000);
  const finalizeIdx = driveBlock.indexOf("finalizeStopWaitingCharge");
  const p2Idx = driveBlock.indexOf("drive_to_next_p2");
  assertEquals(finalizeIdx > 0 && p2Idx > finalizeIdx, true);
  const p2Block = driveBlock.slice(
    driveBlock.lastIndexOf("scheduleEdgeBackground", p2Idx),
    p2Idx + 80,
  );
  assertEquals(p2Block.includes("DRIVE_TO_NEXT_TAPPED"), true);
  assertEquals(p2Block.includes("STOP_WAITING_FINALIZED"), true);
});

Deno.test("arrive enrich skips Admin reload when freeze already durable", async () => {
  const waitingCfg = await Deno.readTextFile(
    new URL("../../functions/_shared/waitingAdminConfig.ts", import.meta.url),
  );
  assertStringIncludes(waitingCfg, "resolveFrozenWaitingConfigOrNull");
  const src = await Deno.readTextFile(stopWorkflowPath);
  assertStringIncludes(src, "resolveFrozenWaitingConfigOrNull");
  assertStringIncludes(src, "skipped_admin_reload");
});

Deno.test("lifecycle perf_id + stage durations returned on stop-workflow success", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  assertStringIncludes(src, "createStopWorkflowLifecyclePerfClock");
  assertStringIncludes(src, "lifecycle_perf_durations_ms");
  assertStringIncludes(src, "perf_id");
  assertStringIncludes(src, "CANONICAL_CONFIRMED");
});

Deno.test("arrive_stop + drive_to_next keep notifications via waitUntil", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  assertStringIncludes(src, "arrive_stop_p2");
  assertStringIncludes(src, "drive_to_next_p2");
  assertStringIncludes(src, 'event: "intermediate_stop_arrived"');
  assertStringIncludes(src, 'event: "next_leg_started"');
  assertStringIncludes(src, "finalizeStopWaitingCharge");
});

Deno.test("complete_trip does not move payment capture; trip_completed notify off-path", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  assertStringIncludes(src, "complete_trip_p2");
  assertStringIncludes(src, 'event: "trip_completed"');
  assertStringIncludes(src, "invokeFinalizeTripCapture");
  assertStringIncludes(src, "assertPlatformCollectedCompletionPaymentGate");
  const completeIdx = src.lastIndexOf('case \'complete_trip\'');
  const completeBlock = src.slice(completeIdx);
  const captureIdx = completeBlock.indexOf("invokeFinalizeTripCapture");
  const notifyBgIdx = completeBlock.indexOf("complete_trip_p2");
  assertEquals(captureIdx > 0 && notifyBgIdx > captureIdx, true);
  // Payment capture must not be inside scheduleEdgeBackground.
  const bgAroundNotify = completeBlock.slice(
    completeBlock.indexOf("scheduleEdgeBackground(async () => {", notifyBgIdx - 80),
    notifyBgIdx + 400,
  );
  assertEquals(bgAroundNotify.includes("invokeFinalizeTripCapture"), false);
});

Deno.test("notifications are not removed from stop-workflow", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  for (const event of [
    "driver_arrived",
    "trip_started",
    "intermediate_stop_arrived",
    "next_leg_started",
    "trip_completed",
  ]) {
    assertStringIncludes(src, `event: "${event}"`);
  }
});
