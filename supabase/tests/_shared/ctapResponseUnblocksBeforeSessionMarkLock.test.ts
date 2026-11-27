/**
 * P1 — CTAP must return after trip insert + booking payable snap without
 * awaiting payment-session trip_created mark on the HTTP critical path.
 * Session mark still runs in waitUntil before post-commit dispatch tasks.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("CTAP waitUntil marks trip_created before postInsertTasks; response is not awaited on mark", async () => {
  const ctap = await Deno.readTextFile(
    new URL("../../functions/create-trip-after-payment/index.ts", import.meta.url),
  );

  assert(ctap.includes("persistBookingPayableSnapshotAfterInsert"));
  assert(ctap.includes("markPaymentSessionTripCreated"));
  assert(ctap.includes("EdgeRuntime.waitUntil"));

  const waitUntilAt = ctap.indexOf("EdgeRuntime.waitUntil((async () => {");
  assert(waitUntilAt > 0, "waitUntil must wrap session mark + post-commit");

  const waitUntilBlock = ctap.slice(waitUntilAt, waitUntilAt + 1200);
  assert(
    waitUntilBlock.includes("await markPaymentSessionTripCreated"),
    "session mark must remain sequenced inside waitUntil before post-commit",
  );
  assert(
    waitUntilBlock.includes("await Promise.allSettled(postInsertTasks)"),
    "post-commit tasks must follow session mark inside the same waitUntil",
  );

  // Critical path after waitUntil kickoff must not re-await the session mark.
  const afterWaitUntil = ctap.slice(waitUntilAt + waitUntilBlock.length, waitUntilAt + waitUntilBlock.length + 800);
  assert(
    !afterWaitUntil.includes("await markPaymentSessionTripCreated"),
    "HTTP response path must not await markPaymentSessionTripCreated",
  );
  assert(afterWaitUntil.includes("return new Response") || ctap.indexOf("bookingMilestones", waitUntilAt) > waitUntilAt);
});
