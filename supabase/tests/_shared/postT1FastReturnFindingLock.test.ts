/**
 * MK-260926-005 — Post-T1 fast return to Finding.
 *
 * After canonical trips.insert, create-trip-after-payment must return ride_id
 * without awaiting payment_session → trip linkage. Linkage remains durable via
 * EdgeRuntime.waitUntil / bookingPostCommit, with reverse-link repair for
 * orphan reconcile and hold release.
 *
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(join(REPO_ROOT, rel));
}

Deno.test("AUTHORISED required before T1 — CTAP still gates payment session", async () => {
  const ctap = await read("supabase/functions/create-trip-after-payment/index.ts");
  assert(ctap.includes("gatePaymentSessionForTripCreate"));
  assert(ctap.includes("verifyRevolutHoldForTripCreateFast"));
  assert(ctap.includes("PAYMENT_NOT_CONFIRMED"));
});

Deno.test("T1 required before Finding seed — response includes ride_id after insert only", async () => {
  const ctap = await read("supabase/functions/create-trip-after-payment/index.ts");
  assert(ctap.includes('.insert(tripData)'));
  assert(ctap.includes("ride_id: trip.id"));
  assert(ctap.includes("canonicalT1At"));
  assert(ctap.includes("responseReadyAt"));
});

Deno.test("minimum response does not await P2 payment_session trip link", async () => {
  const ctap = await read("supabase/functions/create-trip-after-payment/index.ts");
  // Must not block HTTP on markPaymentSessionTripCreated
  assert(!ctap.includes("await markPaymentSessionTripCreated"));
  assert(!/await\s+runPaymentSessionTripLinkAsync/.test(ctap));
  // Must schedule post-commit (includes durable link) then return
  assert(ctap.includes("EdgeRuntime.waitUntil(Promise.allSettled(postInsertTasks))"));
  const waitIdx = ctap.indexOf("EdgeRuntime.waitUntil(Promise.allSettled(postInsertTasks))");
  const returnIdx = ctap.indexOf("ride_id: trip.id", waitIdx);
  assert(waitIdx > 0 && returnIdx > waitIdx);
});

Deno.test("payment_session trip link still scheduled durable post-commit", async () => {
  const post = await read("supabase/functions/_shared/bookingPostCommit.ts");
  assert(post.includes("runPaymentSessionTripLinkAsync"));
  assert(post.includes("bookingPostCommit.waitUntil"));
  assert(post.includes("invokeAutoDispatch"));
  assert(post.includes("markPaymentSessionDispatching"));
});

Deno.test("linkage failure is observable and recoverable", async () => {
  const ssot = await read("supabase/functions/_shared/paymentSessionSSOT.ts");
  assert(ssot.includes("runPaymentSessionTripLinkAsync"));
  assert(ssot.includes("payment_session_trip_link_start"));
  assert(ssot.includes("payment_session_trip_link_async_result"));
  assert(ssot.includes("payment_session_trip_link_failed"));
  assert(ssot.includes("resolveCanonicalTripIdForPaymentSession"));
  assert(ssot.includes("repair_via"));
});

Deno.test("orphan reconcile repairs reverse link instead of false orphan", async () => {
  const orphan = await read("supabase/functions/_shared/revolutOrphanPaymentsSSOT.ts");
  assert(orphan.includes("resolveCanonicalTripIdForPaymentSession"));
  assert(orphan.includes("markPaymentSessionTripCreated"));
  assert(orphan.includes("never orphan a live trip") || orphan.includes("Repair"));
});

Deno.test("hold release resolves reverse trip before tripless cancel", async () => {
  const hold = await read("supabase/functions/_shared/holdReleaseSSOT.ts");
  assert(hold.includes("resolveCanonicalTripIdForPaymentSession"));
  assert(hold.includes("Never treat as tripless"));
});

Deno.test("idempotent retry schedules same-trip link repair", async () => {
  const ctap = await read("supabase/functions/create-trip-after-payment/index.ts");
  assert(ctap.includes("schedulePaymentSessionTripLinkRepair"));
  assert(ctap.includes("ctap.idempotent_client_action_id"));
  assert(ctap.includes("ctap.insert_duplicate_client_action_id"));
});

Deno.test("trip insert still stamps payment_session_id (durable forward link)", async () => {
  const booking = await read("supabase/functions/_shared/bookingSSOT.ts");
  assert(booking.includes("payment_session_id: input.paymentSessionId"));
});

Deno.test("PLATFORM_COLLECTED isolation — link only when paymentSessionId present", async () => {
  const post = await read("supabase/functions/_shared/bookingPostCommit.ts");
  assert(post.includes("ctx.paymentSessionId"));
  assert(post.includes('ctx.paymentProvider === "revolut"'));
});

Deno.test("dispatch/notification retained off response path", async () => {
  const post = await read("supabase/functions/_shared/bookingPostCommit.ts");
  assert(post.includes("invokeAutoDispatch"));
  const ctap = await read("supabase/functions/create-trip-after-payment/index.ts");
  assert(ctap.includes("buildBookingPostCommitTasks"));
  assert(ctap.includes("dispatch_deferred"));
});

Deno.test("Finding seed fields remain on fast response", async () => {
  const ctap = await read("supabase/functions/create-trip-after-payment/index.ts");
  const seedBlock = ctap.slice(
    ctap.indexOf("canonicalT1At"),
    ctap.indexOf("booking_waterfall_report: bookingWaterfallReport"),
  );
  assert(seedBlock.includes("ride_id: trip.id"));
  assert(seedBlock.includes("trip_code: trip.trip_code"));
  assert(seedBlock.includes("status: trip.status"));
  assert(seedBlock.includes("dispatch_mode:"));
  assertEquals(seedBlock.includes("await markPaymentSessionTripCreated"), false);
});

Deno.test("post-T1 telemetry milestones present", async () => {
  const ctap = await read("supabase/functions/create-trip-after-payment/index.ts");
  assert(ctap.includes("canonical_t1_ms"));
  assert(ctap.includes("response_ready_ms"));
  assert(ctap.includes("post_t1_required_ms"));
  const waterfall = await read("supabase/functions/_shared/bookingWaterfallSSOT.ts");
  assert(waterfall.includes("trip_inserted → response_ready"));
});
