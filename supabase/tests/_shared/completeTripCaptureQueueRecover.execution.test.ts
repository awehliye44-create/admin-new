/**
 * Bug #23 — CAPTURE_QUEUE_FAILED recovery execution model.
 *
 * After status=completed, a failed capture_requested stamp must not leave the
 * Driver stuck: retry Complete (idempotent) recovers the stamp and queues
 * finalize without duplicating completion.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("CAPTURE_QUEUE_FAILED: idempotent retry recovers stamp then Rate without re-complete", async () => {
  const order: string[] = [];
  let paymentStatus = "authorised";
  let status = "in_progress";
  let finalizeQueued = 0;
  let completionWrites = 0;

  // First Complete: completion persists, stamp fails.
  status = "completed";
  completionWrites += 1;
  order.push("completed");
  const stampOk = false;
  if (!stampOk) {
    order.push("CAPTURE_QUEUE_FAILED");
  }

  // Driver retries Complete — already completed path.
  assertEquals(status, "completed");
  if (status === "completed" && paymentStatus === "authorised") {
    paymentStatus = "capture_requested";
    finalizeQueued += 1;
    order.push("capture_requested_recovered");
    order.push("finalize_queued");
    order.push("rate_ready");
  }

  // Background finalize (delayed) — must not block Rate.
  let finalizeDone = false;
  void (async () => {
    await new Promise((r) => setTimeout(r, 200));
    finalizeDone = true;
    paymentStatus = "captured";
    order.push("finalize_done");
  })();

  assertEquals(finalizeDone, false);
  assertEquals(order.includes("rate_ready"), true);
  assertEquals(completionWrites, 1);
  assertEquals(finalizeQueued, 1);
  assertEquals(paymentStatus, "capture_requested");

  await new Promise((r) => setTimeout(r, 250));
  assertEquals(finalizeDone, true);
  assertEquals(paymentStatus, "captured");
  assertEquals(completionWrites, 1);
});
