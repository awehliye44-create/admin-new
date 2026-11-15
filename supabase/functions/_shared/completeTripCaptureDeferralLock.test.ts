/**
 * Bug #23 lock — Complete Trip must not await Revolut finalize on the Rate path.
 *
 * After trip status=completed + fare stamp, capture is durably queued
 * (payment_status=capture_requested) and finalize runs via scheduleEdgeBackground.
 * Tip-window TEN also posts in the background.
 */

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("Bug #23 lock: complete_trip defers finalize capture off the response path", async () => {
  const src = await Deno.readTextFile(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  const completeIdx = src.indexOf("case 'complete_trip'");
  assertEquals(completeIdx >= 0, true);
  const block = src.slice(completeIdx, src.indexOf("default:", completeIdx));

  assertStringIncludes(block, 'payment_status: "capture_requested"');
  assertStringIncludes(block, "payment_capture_deferred");
  assertStringIncludes(block, "complete_trip_finalize_capture");
  assertStringIncludes(block, "invokeFinalizeTripCapture");
  // Soft GAP closed: stamp write error must fail closed before Rate success.
  assertStringIncludes(block, "captureRequestedErr");
  assertStringIncludes(block, "CAPTURE_QUEUE_FAILED");

  // Primary Complete path: fail-closed stamp then schedule finalize (not the
  // idempotent-recover path, which also mentions capture_requested).
  const primaryStampAt = block.indexOf("captureRequestedErr");
  const failClosedAt = block.indexOf('"CAPTURE_QUEUE_FAILED"');
  const scheduleLabelAt = block.indexOf("complete_trip_finalize_capture");
  assertEquals(primaryStampAt >= 0, true);
  assertEquals(failClosedAt > primaryStampAt, true);
  assertEquals(scheduleLabelAt > failClosedAt, true);
  const betweenStampAndSchedule = block.slice(primaryStampAt, scheduleLabelAt);
  assertStringIncludes(betweenStampAndSchedule, "scheduleEdgeBackground");
  assertStringIncludes(betweenStampAndSchedule, "await invokeFinalizeTripCapture");
});

Deno.test("Bug #23 lock: idempotent completed recovers missing capture_requested", async () => {
  const src = await Deno.readTextFile(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  const completeIdx = src.indexOf("case 'complete_trip'");
  const block = src.slice(completeIdx, src.indexOf("default:", completeIdx));
  assertStringIncludes(block, "idempotent_already_completed");
  assertStringIncludes(block, "auto_capture_queued_idempotent_recover");
  assertStringIncludes(block, "complete_trip_idempotent_capture_recover");
  assertStringIncludes(block, "isTripPaymentFinalised");
  // Recover runs on already-completed path before Rate success — never re-complete.
  const idempotentAt = block.indexOf("idempotent_already_completed");
  const recoverAt = block.indexOf("auto_capture_queued_idempotent_recover");
  const firstCompleteWrite = block.indexOf("status: 'completed' as TripStatus");
  assertEquals(idempotentAt >= 0, true);
  assertEquals(recoverAt > idempotentAt, true);
  assertEquals(firstCompleteWrite > recoverAt, true);
});

Deno.test("Bug #23 lock: tip-window TEN posts via scheduleEdgeBackground", async () => {
  const src = await Deno.readTextFile(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  const completeIdx = src.indexOf("case 'complete_trip'");
  const block = src.slice(completeIdx, src.indexOf("default:", completeIdx));
  assertStringIncludes(block, "queueTipWindowTen");
  assertStringIncludes(block, "deferred tip-window TEN post failed");
  // After tipWindowDeferred=true, only queueTipWindowTen(...) — no direct await TEN.
  const deferCallRegion = block.slice(
    block.indexOf("tipWindowDeferred = true"),
    block.indexOf("if (!tipWindowDeferred) {"),
  );
  assertStringIncludes(deferCallRegion, "queueTipWindowTen(");
  assertEquals(deferCallRegion.includes("await postTripEarningNetCanonical"), false);
});
