/**
 * Bug #23 latency lock — Complete Trip response must not await:
 * - full trip/stops snapshot refresh
 * - stacked promotion RPC
 * - Revolut finalize (already covered by completeTripCaptureDeferralLock)
 *
 * Authoritative completion + capture_requested (or tip-window) stay on-path.
 *
 * Run: deno test --allow-read supabase/functions/_shared/completeTripLatencyLock.test.ts
 */

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("Bug #23 latency: complete_trip uses skipSnapshotRefresh with in-memory stops", async () => {
  const src = await Deno.readTextFile(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  const completeIdx = src.lastIndexOf("case 'complete_trip'");
  assertEquals(completeIdx >= 0, true);
  const block = src.slice(completeIdx, src.indexOf("default:", completeIdx));

  assertStringIncludes(block, "skipSnapshotRefresh: true");
  assertStringIncludes(block, "responseStops");
  assertStringIncludes(block, 'action: \'complete_trip\'');
  // Must still return durable payment_capture_deferred after capture_requested stamp.
  assertStringIncludes(block, "payment_capture_deferred: paymentCaptureDeferred");
});

Deno.test("Bug #23 latency: stacked promotion runs in complete_trip_p2 background", async () => {
  const src = await Deno.readTextFile(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  const completeIdx = src.lastIndexOf("case 'complete_trip'");
  const block = src.slice(completeIdx, src.indexOf("default:", completeIdx));

  assertStringIncludes(block, "stacked_promotion_enqueue");
  assertStringIncludes(block, "tryPromoteStackedTripAfterCompletion");
  assertStringIncludes(block, "complete_trip_p2");

  const p2LabelAt = block.indexOf("complete_trip_p2");
  assertEquals(p2LabelAt >= 0, true);
  // Promotion must live inside the P2 waitUntil callback (before the label arg).
  const scheduleBeforeP2 = block.lastIndexOf("scheduleEdgeBackground", p2LabelAt);
  assertEquals(scheduleBeforeP2 >= 0, true);
  const p2Block = block.slice(scheduleBeforeP2, p2LabelAt + 30);
  assertStringIncludes(p2Block, "tryPromoteStackedTripAfterCompletion");
  assertStringIncludes(p2Block, "STACKED_TRIP_PROMOTION_AFTER_COMPLETE");
  // Must not await promote on the Rate path after response_ready.
  const responseReadyAt = block.indexOf("stages.mark('response_ready')");
  assertEquals(responseReadyAt > p2LabelAt, true);
  const afterResponse = block.slice(responseReadyAt);
  assertEquals(afterResponse.includes("await tryPromoteStackedTripAfterCompletion"), false);
});

Deno.test("Bug #23 latency: skip waiting aggregate + fare re-select when no open stop waiting", async () => {
  const src = await Deno.readTextFile(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  const completeIdx = src.lastIndexOf("case 'complete_trip'");
  const block = src.slice(completeIdx, src.indexOf("default:", completeIdx));
  assertStringIncludes(block, "closedOpenStopWaiting");
  assertStringIncludes(block, "if (closedOpenStopWaiting)");
  assertStringIncludes(block, "updateTripTotalWaiting");
});

Deno.test("Bug #23 latency: completion write is fail-closed before Rate success", async () => {
  const src = await Deno.readTextFile(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  const completeIdx = src.lastIndexOf("case 'complete_trip'");
  const block = src.slice(completeIdx, src.indexOf("default:", completeIdx));
  assertStringIncludes(block, "COMPLETION_WRITE_FAILED");
  const writeFailAt = block.indexOf("COMPLETION_WRITE_FAILED");
  const responseReadyAt = block.indexOf("response_ready");
  assertEquals(writeFailAt >= 0 && responseReadyAt > writeFailAt, true);
});

Deno.test("Bug #23 latency: no post-complete full-trip re-select on settlement path", async () => {
  const src = await Deno.readTextFile(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  const completeIdx = src.lastIndexOf("case 'complete_trip'");
  const block = src.slice(completeIdx, src.indexOf("default:", completeIdx));
  assertStringIncludes(block, "do not re-select the full trip");
  // Settlement must compose fareTrip locally after completion_writes_end.
  const settlementAt = block.indexOf("stages.mark('settlement_start')");
  const writesEndAt = block.indexOf("stages.mark('completion_writes_end')");
  assertEquals(writesEndAt >= 0 && settlementAt > writesEndAt, true);
  const settlementRegion = block.slice(settlementAt, settlementAt + 800);
  assertEquals(settlementRegion.includes('.select("*")'), false);
});
