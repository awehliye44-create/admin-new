/**
 * MK-261105-002 — payment/booking hardening lock.
 * Run: deno test -A supabase/tests/_shared/mk261105002PaymentBookingHardeningLock.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isSameVerifiedBookingAttempt,
} from "../../functions/_shared/sameBookingAttemptSSOT.ts";
import {
  isCurrentTripPaymentAuthorisation,
} from "../../functions/_shared/lostPaymentAuthorisationTripSSOT.ts";
import {
  PAYMENT_FAILURE_NOTICE_COPY,
  dedupeKeyForBookingCancelledPayment,
  dedupeKeyForBookingNotCreated,
} from "../../functions/_shared/customerPaymentFailureNoticeSSOT.ts";

const ctapPath = new URL("../../functions/create-trip-after-payment/index.ts", import.meta.url);
const holdPath = new URL("../../functions/_shared/holdReleaseSSOT.ts", import.meta.url);
const webhookPath = new URL("../../functions/revolut-webhook/index.ts", import.meta.url);
const dispatchPath = new URL("../../functions/scheduled-dispatch/index.ts", import.meta.url);
const migPath = new URL(
  "../../migrations/20261230120000_mk261105002_payment_booking_hardening.sql",
  import.meta.url,
);

Deno.test("same booking attempt matches CAI / order / session with passenger", () => {
  const trip = {
    id: "t1",
    passenger_id: "p1",
    client_action_id: "cai-1",
    provider_order_id: "ord-1",
    payment_session_id: "ps-1",
  };
  assertEquals(
    isSameVerifiedBookingAttempt(trip, {
      passengerId: "p1",
      clientActionId: "cai-1",
    }),
    true,
  );
  assertEquals(
    isSameVerifiedBookingAttempt(trip, {
      passengerId: "p1",
      providerOrderId: "ord-1",
    }),
    true,
  );
  assertEquals(
    isSameVerifiedBookingAttempt(trip, {
      passengerId: "other",
      clientActionId: "cai-1",
    }),
    false,
  );
  assertEquals(
    isSameVerifiedBookingAttempt(trip, {
      passengerId: "p1",
      clientActionId: "other-cai",
      providerOrderId: "other-ord",
    }),
    false,
  );
});

Deno.test("current auth match: session or order identity", () => {
  assertEquals(
    isCurrentTripPaymentAuthorisation({
      tripPaymentSessionId: "ps-1",
      cancelledSessionId: "ps-1",
      cancelledProviderOrderId: "ord-old",
    }),
    true,
  );
  assertEquals(
    isCurrentTripPaymentAuthorisation({
      tripProviderOrderId: "ord-2",
      cancelledProviderOrderId: "ord-2",
    }),
    true,
  );
  assertEquals(
    isCurrentTripPaymentAuthorisation({
      tripPaymentSessionId: "ps-new",
      tripProviderOrderId: "ord-new",
      cancelledSessionId: "ps-old",
      cancelledProviderOrderId: "ord-old",
    }),
    false,
  );
});

Deno.test("CTAP uses passenger_id and fails closed on idempotency lookup error", async () => {
  const src = await Deno.readTextFile(ctapPath);
  assertStringIncludes(src, "passenger_id");
  assertEquals(src.includes('special_instructions, customer_id"'), false);
  assertEquals(src.includes('.select("id, trip_code, status, special_instructions, customer_id")'), false);
  assertStringIncludes(src, "BOOKING_IDEMPOTENCY_LOOKUP_FAILED");
  assertStringIncludes(src, "isSameVerifiedBookingAttempt");
  assertStringIncludes(src, "schedule_overlap_same_booking");
  assertStringIncludes(src, 'release.status === "has_trip"');
  assertStringIncludes(src, "upsertCustomerPaymentFailureNotice");
  assertStringIncludes(src, "booking_not_created");
});

Deno.test("hold release claims tripless session before Revolut cancel", async () => {
  const src = await Deno.readTextFile(holdPath);
  assertStringIncludes(src, "claim_payment_session_tripless_release");
  assertStringIncludes(src, 'status: "has_trip"');
  assertStringIncludes(src, '.is("trip_id", null)');
  assertStringIncludes(src, "session_linked_to_trip");
  // Must not force-release a linked live trip from the tripless path.
  const claimBlock = src.slice(
    src.indexOf("claim_payment_session_tripless_release"),
    src.indexOf("claim_payment_session_tripless_release") + 1200,
  );
  assertEquals(claimBlock.includes("forceRelease: true"), false);
});

Deno.test("migration defines claim RPC, releasing finalize guard, notices, gate recheck", async () => {
  const sql = await Deno.readTextFile(migPath);
  assertStringIncludes(sql, "claim_payment_session_tripless_release");
  assertStringIncludes(sql, "hold_release_in_progress");
  assertStringIncludes(sql, "customer_payment_failure_notices");
  assertStringIncludes(sql, "list_pending_customer_payment_failure_notices");
  assertStringIncludes(sql, "acknowledge_customer_payment_failure_notice");
  assertStringIncludes(sql, "upsert_customer_payment_failure_notice");
  // Gate must not skip when OLD status was already gated.
  assertEquals(
    sql.includes("IF TG_OP = 'UPDATE' AND v_old_status = ANY(v_gated_states) THEN"),
    false,
  );
  assertStringIncludes(sql, "always re-validate current session auth");
});

Deno.test("webhook cancels trip on lost current authorisation", async () => {
  const src = await Deno.readTextFile(webhookPath);
  assertStringIncludes(src, "cancelTripForLostPaymentAuthorisation");
  assertStringIncludes(src, "lost payment auth trip disposition");
});

Deno.test("scheduled-dispatch asserts payment gate before assign/broadcast/activation", async () => {
  const src = await Deno.readTextFile(dispatchPath);
  assertStringIncludes(src, "assertPaymentGate");
  assertStringIncludes(src, "pending assign payment gate blocked");
  assertStringIncludes(src, "pending broadcast payment gate blocked");
  assertStringIncludes(src, "activation payment gate blocked");
  assertStringIncludes(src, "payment_gate_blocked");
});

Deno.test("customer payment failure notice copy is exact", () => {
  assertEquals(
    PAYMENT_FAILURE_NOTICE_COPY.booking_not_created.message,
    "Your ride wasn’t booked because we couldn’t authorise your payment.",
  );
  assertEquals(
    PAYMENT_FAILURE_NOTICE_COPY.booking_cancelled_payment.message,
    "Your booking was cancelled because we couldn’t secure payment.",
  );
  assertEquals(
    dedupeKeyForBookingNotCreated("cai-1"),
    "booking_not_created:cai:cai-1",
  );
  assertEquals(
    dedupeKeyForBookingCancelledPayment("trip-1"),
    "booking_cancelled_payment:trip:trip-1",
  );
});

Deno.test("lostPaymentAuthorisationTripSSOT refuses superseded / still-authorised", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/lostPaymentAuthorisationTripSSOT.ts", import.meta.url),
  );
  assertStringIncludes(src, "tripHasNewerValidAuthorisation");
  assertStringIncludes(src, "session_still_authorised");
  assertStringIncludes(src, "payment_failure");
  assertStringIncludes(src, "CANCELLED_NO_FEE");
  assertStringIncludes(src, "payment_auth_cancelled");
  assertStringIncludes(src, "revokePendingOffersForTerminalTrip");
  assertStringIncludes(src, "lostAuthCustomerCopyForTripStatus");
  assertStringIncludes(src, "inProgressCancelPolicyNeedsDecision");
});
