/**
 * Booking/preauth customer copy invariant (unified-bank-decline-copy lock):
 *   issuer/card/network decline reason (incl. failed 3DS) → unified bank copy
 *   payment state (FAILED/DECLINED), generic failed/declined text, technical,
 *   risk, merchant, form data, timeout, unknown → neutral
 *   abandoned / rejected 3DS → cancellation; raw provider/internal text never shown.
 */
import { assert, assertEquals, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  humanizeRevolutBookingCustomerError,
  humanizeRevolutPreauthCustomerError,
  isRevolutIssuerCardDeclineReason,
  REVOLUT_CARD_DECLINED_CUSTOMER_MESSAGE,
  REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE,
} from "../../functions/_shared/revolutCustomerError.ts";

const BANK_WORDING = /\b(bank|issuer)\b|declin/i;

function assertNeutral(input: string | null | undefined, out: string) {
  assertStrictEquals(BANK_WORDING.test(out), false, `${String(input)} → ${out}`);
}

Deno.test("issuer/card decline_reason → bank wording", () => {
  for (
    const reason of [
      "do_not_honour",
      "issuer_decline",
      "insufficient_funds",
      "restricted_card",
      "expired_card",
      "pick_up_card",
      "withdrawal_limit_exceeded",
      "transaction_not_allowed_for_cardholder",
      "REVOLUT_PAYMENT_FAILED:do_not_honour",
      "do_not_honor",
      "issuer_declined",
      "card_declined",
      "card_not_supported",
      "3ds_challenge_failed",
      "3ds_challenge_failed_manually",
      "customer_challenge_failed",
      "authentication_required",
      "doNotHonour",
      "insufficientFunds",
      "threeDSChallengeFailed",
      "REVOLUT_PAYMENT_DECLINED:INSUFFICIENT_FUNDS",
    ]
  ) {
    assert(isRevolutIssuerCardDeclineReason(reason), reason);
    assertEquals(humanizeRevolutPreauthCustomerError(reason), REVOLUT_CARD_DECLINED_CUSTOMER_MESSAGE, reason);
  }
});

Deno.test("payment states and non-issuer reasons → neutral, never bank wording", () => {
  for (
    const reason of [
      "FAILED",
      "DECLINED",
      "failed",
      "declined",
      "technical_error",
      "issuer_not_available",
      "high_risk",
      "suspected_fraud",
      "invalid_merchant",
      "invalid_amount",
      "invalid_email",
      "invalid_address",
      "invalid_country",
      "invalid_phone",
      "cardholder_name_missing",
      "customer_name_mismatch",
      "REVOLUT_PAYMENT_FAILED",
    ]
  ) {
    assertStrictEquals(isRevolutIssuerCardDeclineReason(reason), false, reason);
    const out = humanizeRevolutPreauthCustomerError(reason);
    assertEquals(out, REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE, reason);
    assertNeutral(reason, out);
  }
});

Deno.test("abandoned / rejected 3DS → cancellation, never bank decline", () => {
  for (
    const reason of [
      "3ds_challenge_abandoned",
      "customer_challenge_abandoned",
      "rejected_by_customer",
      "threeDSChallengeAbandoned",
    ]
  ) {
    assertStrictEquals(isRevolutIssuerCardDeclineReason(reason), false, reason);
    assertEquals(
      humanizeRevolutPreauthCustomerError(reason),
      "Payment was cancelled. No booking has been created.",
      reason,
    );
  }
});

Deno.test("generic failed/declined/suspicious text → neutral (was bank wording)", () => {
  for (
    const text of [
      "Saved card payment failed",
      "Payment failed",
      "Payment failed. Start a new booking to try again.",
      "Payment declined",
      "Suspicious activity",
      "Payment not authorized. Status: FAILED",
      "Revolut API error 422: payment failed",
    ]
  ) {
    const out = humanizeRevolutPreauthCustomerError(text);
    assertEquals(out, REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE, text);
    assertNeutral(text, out);
  }
});

Deno.test("unknown codes and internal/provider text are never shown raw", () => {
  for (
    const text of [
      "captured_before_trip_completion",
      "PENDING",
      "Payment invariant violation: capture before trip completion",
      "Revolut API error 400: Invalid request",
      "TypeError: exception in fetch",
      "[object Object]",
    ]
  ) {
    const out = humanizeRevolutPreauthCustomerError(text);
    assert(out !== text, `raw text surfaced: ${text}`);
    assertNeutral(text, out);
  }
  assertEquals(
    humanizeRevolutBookingCustomerError("captured_before_trip_completion"),
    "We're confirming your payment. Please do not pay again.",
  );
});

Deno.test("unknown / timeout / empty → neutral copy", () => {
  for (const text of [undefined, null, "", "timeout", "Request timed out", "network unreachable"]) {
    assertNeutral(text, humanizeRevolutPreauthCustomerError(text));
  }
});

Deno.test("unchanged mappings: cancel, not configured, still processing, curated copy", () => {
  assertEquals(
    humanizeRevolutPreauthCustomerError("Payment was cancelled. Start a new booking to try again."),
    "Payment was cancelled. No booking has been created.",
  );
  assertEquals(humanizeRevolutPreauthCustomerError("CANCELLED"), "Payment was cancelled. No booking has been created.");
  assert(humanizeRevolutPreauthCustomerError("Revolut merchant not configured").startsWith("Card payments aren't available"));
  const processing = "Saved card payment is still processing. Please try again in a moment.";
  assertEquals(humanizeRevolutPreauthCustomerError(processing), processing);
  const technical = "Payment couldn’t be completed. Please try again in a moment.";
  assertEquals(humanizeRevolutPreauthCustomerError(technical), technical);
  assertEquals(
    humanizeRevolutBookingCustomerError("Payment not authorized. Status: PENDING"),
    "We're confirming your payment. Please do not pay again.",
  );
  assertEquals(
    humanizeRevolutBookingCustomerError("Payment not authorized. Status: FAILED"),
    REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE,
  );
});
