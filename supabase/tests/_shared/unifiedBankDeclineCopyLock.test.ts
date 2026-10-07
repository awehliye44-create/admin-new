/**
 * Unified bank-decline copy lock (.cursor/rules/unified-bank-decline-copy-lock.mdc).
 *
 * Bank/issuer/card declines show one popup for every payment method; trip
 * changes use the trip-change variant (OK only). Technical, risk, internal,
 * unknown and cancelled outcomes never get bank wording.
 *
 * Run:
 *   deno test --allow-read supabase/tests/_shared/unifiedBankDeclineCopyLock.test.ts
 *
 * If this fails, fix the code — never delete or soften the lock.
 */
import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BANK_DECLINE_REASONS,
  BANK_DECLINE_TITLE,
  findBankDeclineReason,
  isPaymentCancellationReason,
  normalizeDeclineReason,
  PAYMENT_CANCELLATION_REASONS,
  REVOLUT_CARD_DECLINED_CUSTOMER_MESSAGE,
  TRIP_CHANGE_BANK_DECLINED_CUSTOMER_MESSAGE,
} from "../../functions/_shared/revolutCustomerError.ts";
import {
  classifyGooglePaySubmitFailure,
  latestFailedPaymentDeclineReason,
} from "../../functions/_shared/googlePaySubmitOutcome.ts";
import {
  classifyModificationPaymentFailure,
  decideFromPreauthInvokeResult,
} from "../../functions/_shared/tripModificationPaymentGateSSOT.ts";

const read = (path: string) => Deno.readTextFile(new URL(path, import.meta.url));

/** Must equal the Customer app list (src/features/payments/bankDeclineReasons.ts). */
const EXPECTED_BANK_DECLINE_REASONS = [
  "3ds_challenge_failed",
  "3ds_challenge_failed_manually",
  "authentication_required",
  "card_declined",
  "card_expired",
  "card_not_supported",
  "customer_challenge_failed",
  "declined_by_issuer",
  "do_not_honor",
  "do_not_honour",
  "expired_card",
  "incorrect_cvc",
  "incorrect_cvv",
  "incorrect_expiry",
  "incorrect_pin",
  "insufficient_funds",
  "invalid_account",
  "invalid_cvc",
  "invalid_cvv",
  "invalid_expiry",
  "invalid_expiry_date",
  "invalid_pin",
  "issuer_decline",
  "issuer_declined",
  "lost_card",
  "new_card_not_unblocked",
  "not_sufficient_funds",
  "pick_up_card",
  "pickup_card",
  "pin_tries_exceeded",
  "pin_try_exceeded",
  "restricted_card",
  "stolen_card",
  "transaction_not_allowed_for_cardholder",
  "withdrawal_frequency_exceeded",
  "withdrawal_limit_exceeded",
];

const NEVER_BANK_DECLINE = [
  "high_risk",
  "suspected_fraud",
  "issuer_not_available",
  "technical_error",
  "timeout",
  "unknown",
  "invalid_merchant",
  "invalid_email",
  "invalid_amount",
  "invalid_address",
  "invalid_country",
  "invalid_phone",
  "cardholder_name_missing",
  "customer_name_mismatch",
  "INCREMENT_CONFIRM_PERSIST_FAILED",
  "persist_failed",
  "PROVIDER_INCREMENT_FAILED",
  "declined",
  "failed",
  "DECLINED",
  "REVOLUT_PAYMENT_FAILED",
  "REVOLUT_PAYMENT_DECLINED",
  "3ds_challenge_abandoned",
  "customer_challenge_abandoned",
  "rejected_by_customer",
];

Deno.test("unified copy is exact and never blames ONECAB, wallets or Revolut", () => {
  assertEquals(BANK_DECLINE_TITLE, "Payment declined by your bank");
  assertEquals(
    REVOLUT_CARD_DECLINED_CUSTOMER_MESSAGE,
    "Your bank declined this payment. Please check your card, use another card, or choose another payment method.",
  );
  assertEquals(
    TRIP_CHANGE_BANK_DECLINED_CUSTOMER_MESSAGE,
    "Your bank declined the payment for this trip change. Please check your card or contact your bank, then try the change again.",
  );
  for (const copy of [REVOLUT_CARD_DECLINED_CUSTOMER_MESSAGE, TRIP_CHANGE_BANK_DECLINED_CUSTOMER_MESSAGE]) {
    assertFalse(/onecab|apple pay|google pay|revolut/i.test(copy), copy);
  }
  assertFalse(/another card/i.test(TRIP_CHANGE_BANK_DECLINED_CUSTOMER_MESSAGE));
});

Deno.test("one shared bank-decline list (parity with Customer app)", () => {
  assertEquals([...BANK_DECLINE_REASONS].sort(), EXPECTED_BANK_DECLINE_REASONS);
  assertEquals([...PAYMENT_CANCELLATION_REASONS].sort(), [
    "3ds_challenge_abandoned",
    "customer_challenge_abandoned",
    "rejected_by_customer",
  ]);
});

Deno.test("Revolut / card-network spellings normalise to the canonical reason", () => {
  assertEquals(normalizeDeclineReason("doNotHonour"), "do_not_honour");
  assertEquals(normalizeDeclineReason("DO-NOT-HONOR"), "do_not_honor");
  assertEquals(normalizeDeclineReason("insufficientFunds"), "insufficient_funds");
  assertEquals(normalizeDeclineReason("threeDSChallengeFailed"), "3ds_challenge_failed");
  assertEquals(normalizeDeclineReason("three_ds_challenge_failed_manually"), "3ds_challenge_failed_manually");
  assertEquals(normalizeDeclineReason("invalidCVV"), "invalid_cvv");
  assertEquals(findBankDeclineReason("REVOLUT_PAYMENT_DECLINED:insufficient_funds"), "insufficient_funds");
  assertEquals(findBankDeclineReason(null, "card_declined"), "card_declined");
  assertEquals(findBankDeclineReason("Issuer_Declined"), "issuer_declined");
});

Deno.test("technical, risk, internal, unknown and form errors are never bank declines", () => {
  for (const reason of NEVER_BANK_DECLINE) {
    assertEquals(findBankDeclineReason(reason), null, reason);
  }
  assertEquals(findBankDeclineReason(null, undefined, ""), null);
});

Deno.test("abandoned / rejected 3DS is a cancellation; failed 3DS is a bank decline", () => {
  assert(isPaymentCancellationReason("3ds_challenge_abandoned"));
  assert(isPaymentCancellationReason("threeDSChallengeAbandoned"));
  assert(isPaymentCancellationReason("rejectedByCustomer"));
  assertEquals(findBankDeclineReason("threeDSChallengeAbandoned"), null);
  assertEquals(findBankDeclineReason("3ds_challenge_failed_manually"), "3ds_challenge_failed_manually");
  assertFalse(isPaymentCancellationReason("3ds_challenge_failed"));
});

Deno.test("Google Pay + insufficient funds → same booking bank-decline copy", () => {
  const out = classifyGooglePaySubmitFailure({
    declineReason: "insufficient_funds",
    providerRejected: true,
  });
  assertEquals(out.code, "PAYMENT_DECLINED_BY_BANK");
  assertEquals(out.status, 402);
  assertEquals(out.message, REVOLUT_CARD_DECLINED_CUSTOMER_MESSAGE);
  assertEquals(out.decline_reason, "insufficient_funds");
  assert(out.bank_declined);
});

Deno.test("Google Pay non-bank / unknown failures stay neutral and never say Google Pay", () => {
  for (
    const args of [
      { declineReason: "high_risk", providerRejected: true },
      { declineReason: "technical_error", providerRejected: true },
      { declineReason: null, providerRejected: true },
      { declineReason: null, providerRejected: false },
    ]
  ) {
    const out = classifyGooglePaySubmitFailure(args);
    assertFalse(out.bank_declined, JSON.stringify(args));
    assertFalse(/bank|declin|google pay/i.test(out.message), out.message);
  }
  assertEquals(
    classifyGooglePaySubmitFailure({ declineReason: null, providerRejected: false }).code,
    "GOOGLE_PAY_SUBMIT_FAILED",
  );
});

Deno.test("latest failed payment's decline_reason is used", () => {
  assertEquals(
    latestFailedPaymentDeclineReason([
      { state: "declined", decline_reason: "high_risk" },
      { state: "authorisation_started" },
      { state: "DECLINED", decline_reason: "do_not_honour" },
    ]),
    "do_not_honour",
  );
  assertEquals(latestFailedPaymentDeclineReason([{ state: "authorised" }]), null);
  assertEquals(latestFailedPaymentDeclineReason(undefined), null);
});

Deno.test("trip change: Revolut-evidenced issuer decline → bank_declined", () => {
  const gate = decideFromPreauthInvokeResult({
    success: false,
    requiredPayablePence: 1200,
    authorisedAmountPence: 900,
    paymentCoverageStatus: "authorization_insufficient",
    errorCode: "AUTHORISED_TOTAL_BELOW_TARGET",
  });
  assertEquals(gate.phase, "PAYMENT_FAILED");
  assertEquals(
    classifyModificationPaymentFailure({ gate, declineReason: "insufficient_funds" }),
    { kind: "bank_declined", bankDeclineReason: "insufficient_funds" },
  );
  assertEquals(
    classifyModificationPaymentFailure({ gate, declineReason: "do_not_honour" }).kind,
    "bank_declined",
  );
});

Deno.test("trip change: below target without issuer reason → not_authorised (no bank copy)", () => {
  const gate = decideFromPreauthInvokeResult({
    success: false,
    requiredPayablePence: 1200,
    authorisedAmountPence: 900,
    paymentCoverageStatus: "authorization_insufficient",
    errorCode: "AUTHORISED_TOTAL_BELOW_TARGET",
  });
  assertEquals(classifyModificationPaymentFailure({ gate }).kind, "not_authorised");
  assertEquals(
    classifyModificationPaymentFailure({ gate, declineReason: "high_risk" }).kind,
    "not_authorised",
  );
});

Deno.test("trip change: provider technical and internal persist failures → technical, never declined", () => {
  for (
    const args of [
      { errorCode: "PROVIDER_INCREMENT_FAILED", paymentCoverageStatus: "authorization_provider_failed" },
      { errorCode: "INCREMENT_CONFIRM_PERSIST_FAILED", paymentCoverageStatus: "authorization_persist_failed" },
      { errorCode: "PERSIST_FAILED", paymentCoverageStatus: "authorization_persist_failed" },
    ]
  ) {
    const gate = decideFromPreauthInvokeResult({
      success: false,
      requiredPayablePence: 1200,
      authorisedAmountPence: 900,
      ...args,
    });
    assertEquals(gate.phase, "PAYMENT_FAILED", JSON.stringify(args));
    assertEquals(gate.phase === "PAYMENT_FAILED" ? gate.reason : null, "failed");
    assertEquals(
      classifyModificationPaymentFailure({ gate, declineReason: "insufficient_funds" }).kind,
      "technical",
      JSON.stringify(args),
    );
  }
});

Deno.test("trip change: backend returns trip-change copy only for bank declines", async () => {
  const exec = await read("../../functions/_shared/executeFareIncreaseModificationPayment.ts");
  assertStringIncludes(exec, 'if (failure.kind === "bank_declined") return TRIP_CHANGE_BANK_DECLINED_CUSTOMER_MESSAGE;');
  assertStringIncludes(exec, "PAYMENT_AUTHORISATION_FAILED");
  assertFalse(exec.includes("Payment declined for the fare increase"));
  assertFalse(exec.includes("Insufficient funds for the fare increase"));

  const request = await read("../../functions/request-trip-modification/index.ts");
  assertEquals(request.match(/decline_reason: (paymentResult|resume)\.declineReason/g)?.length, 2);
  assertEquals(request.match(/bank_declined: (paymentResult|resume)\.bankDeclined === true/g)?.length, 2);
});

Deno.test("Google Pay submit resolves the provider reason before choosing copy", async () => {
  const src = await read("../../functions/submit-revolut-google-pay/index.ts");
  assertFalse(src.includes('"Google Pay submission failed"'));
  assertStringIncludes(src, "latestFailedPaymentDeclineReason(after.payments)");
  assertStringIncludes(src, "classifyGooglePaySubmitFailure");
});

Deno.test("saved-card synchronous decline returns the provider decline reason", async () => {
  const src = await read("../../functions/_shared/revolutPreauth.ts");
  assertStringIncludes(src, "decline_reason: declineReason,");
  assertStringIncludes(src, "bank_declined: findBankDeclineReason(declineReason) !== null,");
});
