/**
 * MK-260916-030 incremental payment SSOT lock tests.
 *
 * FARE → MONEY PROTECTION → TRIP.
 * Never: increased payable without verified protection; never complete across
 * unresolved positive increment.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideFromPreauthInvokeResult,
  decideModificationIncrementCoverage,
  poundsToPenceExact,
  simulateModificationAuthorisationSequence,
} from "../../functions/_shared/tripModificationPaymentGateSSOT.ts";
import {
  CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED,
  resolveCommittedCustomerPayablePence,
  resolveProtectedCustomerPayablePence,
} from "../../functions/_shared/executeFareIncreaseModificationPayment.ts";
import type { RevolutOrder } from "../../functions/_shared/revolutOrders.ts";

function orderShape(args: {
  paymentAuth: number;
  increments?: Array<{ old_amount: number; new_amount: number; state: string }>;
}): RevolutOrder {
  return {
    id: "ord_mk030",
    state: "AUTHORISED",
    amount: args.paymentAuth,
    authorised_amount: undefined,
    payments: [{
      authorised_amount: args.paymentAuth,
      amount: args.paymentAuth,
    }],
    incremental_authorisations: args.increments ?? [],
  };
}

Deno.test("MK-260916-030: 500→1031 requires +531 and blocks apply while processing", () => {
  const protectedPence = 500;
  const revised = 1031;
  const requiredIncrement = revised - protectedPence;
  assertEquals(requiredIncrement, 531);

  const whilePending = decideModificationIncrementCoverage({
    order: orderShape({
      paymentAuth: protectedPence,
      increments: [{
        old_amount: protectedPence,
        new_amount: revised,
        state: "processing",
      }],
    }),
    requiredPayablePence: revised,
  });
  assertEquals(whilePending.mayApply, false);
  assertEquals(whilePending.phase, "PAYMENT_PENDING");
  assertEquals(whilePending.authorisedTotalPence < revised, true);
});

Deno.test("MK-260916-030: success path verifies protected >= revised before apply", () => {
  const sequence = simulateModificationAuthorisationSequence({
    originalAuthorisedPence: 500,
    requiredPayablePence: 1031,
    providerSnapshots: [
      orderShape({
        paymentAuth: 500,
        increments: [{ old_amount: 500, new_amount: 1031, state: "processing" }],
      }),
      orderShape({
        paymentAuth: 500,
        increments: [{ old_amount: 500, new_amount: 1031, state: "authorised" }],
      }),
    ],
  });
  assertEquals(sequence.applied, true);
  assertEquals(sequence.finalAuthorisedPence >= 1031, true);
});

Deno.test("MK-260916-030: failure leaves trip at original protected amount", () => {
  const declined = decideFromPreauthInvokeResult({
    success: false,
    requiredPayablePence: 1031,
    authorisedAmountPence: 500,
    paymentCoverageStatus: "authorization_insufficient",
  });
  assertEquals(declined.mayApply, false);
  assertEquals(declined.phase, "PAYMENT_FAILED");
  assertEquals(declined.authorisedTotalPence, 500);
});

Deno.test("protected vs committed helpers: under-protection is detectable", () => {
  const trip = {
    authorised_amount_pence: 500,
    final_customer_fare_pence: 1031,
    estimated_total_pence: 1031,
  };
  assertEquals(resolveProtectedCustomerPayablePence(trip), 500);
  assertEquals(resolveCommittedCustomerPayablePence(trip), 1031);
  assertEquals(
    resolveProtectedCustomerPayablePence(trip) >=
      resolveCommittedCustomerPayablePence(trip),
    false,
  );
});

Deno.test("caller audit: backend owns increment; completion gates unresolved", async () => {
  const request = await Deno.readTextFile(
    new URL("../../functions/request-trip-modification/index.ts", import.meta.url),
  );
  assertStringIncludes(request, "executeFareIncreaseModificationPayment");
  assertStringIncludes(request, "PLATFORM_COLLECTED");
  assertEquals(request.includes("paymentRequired = fareDeltaPence > 0;"), false);
  // Existing payment_* gate is resumed by backend — not handed to Customer confirm.
  assertStringIncludes(request, 'existingStatus === "payment_required"');
  assertStringIncludes(request, 'existingStatus === "payment_pending"');
  assertStringIncludes(request, "Existing modification payment completed");
  assertEquals(
    request.includes("Please complete payment confirmation for the current modification request"),
    false,
  );

  const confirm = await Deno.readTextFile(
    new URL("../../functions/confirm-trip-modification-payment/index.ts", import.meta.url),
  );
  assertStringIncludes(confirm, "executeFareIncreaseModificationPayment");
  assertEquals(confirm.includes("advance_trip_change_after_payment"), false);

  const stop = await Deno.readTextFile(
    new URL("../../functions/stop-workflow/index.ts", import.meta.url),
  );
  assertStringIncludes(stop, "assertPlatformCollectedCompletionPaymentGate");
  assertEquals(stop.includes("trip_has_unresolved_fare_increase_modification"), false);

  const capture = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  assertStringIncludes(capture, "assertPlatformCollectedCompletionPaymentGate");
  assertStringIncludes(capture, CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED);

  const admin = await Deno.readTextFile(
    new URL("../../functions/admin-trip-action/index.ts", import.meta.url),
  );
  assertStringIncludes(admin, "assertPlatformCollectedCompletionPaymentGate");
  assertStringIncludes(admin, "Cannot raise customer payable on force_complete");

  const apply = await Deno.readTextFile(
    new URL("../../functions/apply-trip-change/index.ts", import.meta.url),
  );
  assertStringIncludes(apply, "CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED");
  assertStringIncludes(apply, "effectiveIncreasePence");
  assertStringIncludes(apply, "currentCommittedPence");
  // Approve CR first — never write trips fare/stops before payment trigger.
  assertStringIncludes(apply, "Never write trips.estimated_total");
  assertStringIncludes(apply, 'status: "approved"');
  assertEquals(apply.includes("haversineKm"), false);
  assertEquals(apply.includes("estimated_total_pence: newFarePence"), false);
  assertEquals(apply.includes("Quoted payable missing for fare-increasing"), false);

  const adminCapture = await Deno.readTextFile(
    new URL("../../functions/_shared/adminCaptureTripPaymentSSOT.ts", import.meta.url),
  );
  assertStringIncludes(adminCapture, "assertPlatformCollectedCompletionPaymentGate");

  const preauth = await Deno.readTextFile(
    new URL("../../functions/update-preauth-on-trip-modification/index.ts", import.meta.url),
  );
  assertStringIncludes(preauth, "FINANCIAL_MODEL_VIOLATION");
  assertStringIncludes(preauth, "DRIVER_COLLECTED");

  const respond = await Deno.readTextFile(
    new URL("../../functions/respond-trip-modification/index.ts", import.meta.url),
  );
  assertStringIncludes(respond, "CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED");
  assertStringIncludes(respond, "payment_status !== \"confirmed\"");
  assertStringIncludes(respond, "effectiveIncrease");
  assertStringIncludes(respond, "quotedIncrease");

  // Legacy completion paths must not bypass the payment gate (MK-260916-030).
  const updateStopStatus = await Deno.readTextFile(
    new URL("../../functions/update-stop-status/index.ts", import.meta.url),
  );
  assertStringIncludes(updateStopStatus, "DEPRECATED_ENDPOINT");
  assertEquals(updateStopStatus.includes('status: "completed"'), false);

  const completeStop = await Deno.readTextFile(
    new URL("../../functions/complete-stop/index.ts", import.meta.url),
  );
  assertStringIncludes(completeStop, "legacyEdgeBlockedResponse");
  assertEquals(completeStop.includes("LEGACY_PATH_EXECUTED"), false);

  const legacyGuard = await Deno.readTextFile(
    new URL("../../functions/_shared/legacyEdgeGuard.ts", import.meta.url),
  );
  assertStringIncludes(legacyGuard, '"update-stop-status"');
  assertStringIncludes(legacyGuard, '"complete-stop"');
  assertStringIncludes(legacyGuard, '"calculate-final-fare"');

  const calculateFinalFare = await Deno.readTextFile(
    new URL("../../functions/calculate-final-fare/index.ts", import.meta.url),
  );
  assertStringIncludes(calculateFinalFare, "DEPRECATED_ENDPOINT");
  assertEquals(calculateFinalFare.includes("change_destination"), false);
  assertEquals(calculateFinalFare.includes("final_fare_pence"), false);

  const negotiation = await Deno.readTextFile(
    new URL("../../functions/_shared/negotiationPayableAuthorisation.ts", import.meta.url),
  );
  assertStringIncludes(negotiation, "FINANCIAL_MODEL_VIOLATION");
  assertStringIncludes(negotiation, "DRIVER_COLLECTED");

  const exec = await Deno.readTextFile(
    new URL("../../functions/_shared/executeFareIncreaseModificationPayment.ts", import.meta.url),
  );
  assertStringIncludes(exec, "claim_and_apply_fare_increase_modification");
  assertStringIncludes(exec, "assert_trip_completion_customer_payment_gate");
  assertStringIncludes(exec, "payment_sessions");
  assertStringIncludes(exec, "FINANCIAL_MODEL_VIOLATION");
  assertStringIncludes(exec, "DRIVER_COLLECTED_COMMISSION_WALLET");
  assertEquals(
    exec.includes("Fallback if migration not yet applied"),
    false,
  );
});

Deno.test("atomic migration serializes claim with FOR UPDATE", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20261112180000_atomic_fare_increase_modification_claim.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(sql, "claim_and_apply_fare_increase_modification");
  assertStringIncludes(sql, "trip_has_unresolved_fare_increase_modification");
  assertStringIncludes(sql, "FOR UPDATE");
  assertStringIncludes(sql, "ADDITIONAL_AUTHORISATION_CONFIRMED");
  assertStringIncludes(sql, "uq_psa_additional_auth_confirmed_per_modification");

  const broaden = await Deno.readTextFile(
    new URL(
      "../../migrations/20261112181000_unresolved_mod_payment_status_lock.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(broaden, "trip_has_unresolved_fare_increase_modification");
  assertStringIncludes(broaden, "'required'");
  assertStringIncludes(broaden, "'pending'");
  assertStringIncludes(broaden, "payment_status");
});

Deno.test("completion gate migration locks trip and requires protected >= committed", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20261112180500_completion_payment_gate_lock.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(sql, "assert_trip_completion_customer_payment_gate");
  assertStringIncludes(sql, "FOR UPDATE");
  assertStringIncludes(sql, "CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED");
  assertStringIncludes(sql, "PLATFORM_COLLECTED");
  assertStringIncludes(sql, "protected_pence");
  assertStringIncludes(sql, "required_pence");

  const pendingFix = await Deno.readTextFile(
    new URL(
      "../../migrations/20261127120000_pending_mod_does_not_block_completion.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(pendingFix, "payment_confirmed");
  assertEquals(pendingFix.includes("'payment_required'"), false);
  assertEquals(pendingFix.includes("'payment_pending'"), false);
});

Deno.test("DB apply guard blocks unpaid PLATFORM approved/applied increases", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20261112181500_trip_change_payment_apply_guard.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(sql, "enforce_trip_change_payment_before_apply");
  assertStringIncludes(sql, "trg_trip_change_payment_before_apply");
  assertStringIncludes(sql, "CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED");
  assertStringIncludes(sql, "payment_status");
  assertStringIncludes(sql, "Customers can create modification requests");
  assertStringIncludes(sql, "IS DISTINCT FROM 'confirmed'");
});

Deno.test("driver PostgREST cannot forge payment_status to apply increases", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20261112182000_trip_change_driver_update_lock.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(sql, 'DROP POLICY IF EXISTS "Drivers can respond to modification requests"');
  assertStringIncludes(sql, "REVOKE UPDATE, DELETE ON public.trip_change_requests FROM authenticated");
  assertStringIncludes(sql, "ADDITIONAL_AUTHORISATION_CONFIRMED");
  assertStringIncludes(sql, "v_protected");
  assertStringIncludes(sql, "CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED");
  assertStringIncludes(sql, "missing ADDITIONAL_AUTHORISATION_CONFIRMED evidence");
});

Deno.test("claim fails closed without ADDITIONAL_AUTHORISATION_CONFIRMED evidence", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20261112182500_claim_requires_auth_evidence.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(sql, "claim_and_apply_fare_increase_modification");
  assertStringIncludes(sql, "missing_payment_session_for_fare_increase");
  assertStringIncludes(sql, "missing_ADDITIONAL_AUTHORISATION_CONFIRMED_evidence");
  assertStringIncludes(sql, "advance_trip_change_after_payment");
  // Evidence check must run before advance.
  assertEquals(
    sql.indexOf("missing_ADDITIONAL_AUTHORISATION_CONFIRMED_evidence")
      < sql.indexOf("advance_trip_change_after_payment(p_request_id)"),
    true,
  );
});

Deno.test("poundsToPenceExact still exact for review screen class", () => {
  assertEquals(poundsToPenceExact(5.0), 500);
  assertEquals(poundsToPenceExact(10.31), 1031);
});
