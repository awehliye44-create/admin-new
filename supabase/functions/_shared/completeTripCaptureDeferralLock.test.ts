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

  // Finalize runs only inside the background scheduler after capture_requested stamp.
  const stampAt = block.indexOf('payment_status: "capture_requested"');
  const scheduleLabelAt = block.indexOf("complete_trip_finalize_capture");
  const awaitFinalizeAt = block.indexOf("await invokeFinalizeTripCapture");
  assertEquals(stampAt >= 0, true);
  assertEquals(scheduleLabelAt > stampAt, true);
  assertEquals(awaitFinalizeAt > stampAt, true);
  const betweenStampAndAwait = block.slice(stampAt, awaitFinalizeAt);
  assertStringIncludes(betweenStampAndAwait, "scheduleEdgeBackground");
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
