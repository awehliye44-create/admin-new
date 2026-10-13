/**
 * Driver-safe / customer-safe Revolut payment error messages.
 *
 * Bank-decline wording only when the input carries a decline reason that the
 * bank, card issuer or card network is responsible for (unified-bank-decline-copy
 * lock). Revolut uses the `declined` and `failed` payment states for technical,
 * risk and data failures too, so a state, generic "failed"/"declined" text, a
 * timeout or an unknown reason always gets neutral copy. Raw provider/internal
 * text is never shown.
 */
import { REVOLUT_PAYMENT_SETUP_FAILED_MESSAGE } from "./revolutPreauthCustomerAttach.ts";

const FRIENDLY_DEFAULT =
  "We couldn't complete your payment. Please try again or use another payment method.";

const FRIENDLY_NOT_CONFIGURED =
  "Card payments aren't available in this area right now. Please try again later or contact support.";

const FRIENDLY_NOT_AUTHORISED =
  "We're confirming your payment. Please do not pay again.";

const FRIENDLY_CANCELLED =
  "Payment was cancelled. No booking has been created.";

const FRIENDLY_TIMEOUT = "Payment timed out. Please check your connection and try again.";

export const BANK_DECLINE_TITLE = "Payment declined by your bank";

/** Booking / new payment — same copy for every payment method. */
export const REVOLUT_CARD_DECLINED_CUSTOMER_MESSAGE =
  "Your bank declined this payment. Please check your card, use another card, or choose another payment method.";

/** Trip modification — no card switch mid-trip (same-order increment only). */
export const TRIP_CHANGE_BANK_DECLINED_CUSTOMER_MESSAGE =
  "Your bank declined the payment for this trip change. Please check your card or contact your bank, then try the change again.";

export const REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE =
  "We couldn't authorise the payment. Please try again or use another payment method.";

/**
 * Canonical decline reasons the bank, card issuer or card network is
 * responsible for — Revolut `decline_reason` values plus card-network /
 * alternative spellings. Must match the Customer app list
 * (`src/features/payments/bankDeclineReasons.ts`).
 *
 * Never bank declines: high_risk / suspected_fraud (may be Revolut's own risk
 * tools), issuer_not_available / technical_error (technical), invalid_merchant
 * (merchant configuration), form/data errors, and unknown reasons.
 */
export const BANK_DECLINE_REASONS: ReadonlySet<string> = new Set([
  "issuer_decline",
  "issuer_declined",
  "declined_by_issuer",
  "card_declined",
  "do_not_honour",
  "do_not_honor",
  "insufficient_funds",
  "not_sufficient_funds",
  "expired_card",
  "card_expired",
  "lost_card",
  "stolen_card",
  "restricted_card",
  "pick_up_card",
  "pickup_card",
  "card_not_supported",
  "transaction_not_allowed_for_cardholder",
  "invalid_cvv",
  "incorrect_cvv",
  "invalid_cvc",
  "incorrect_cvc",
  "invalid_expiry",
  "invalid_expiry_date",
  "incorrect_expiry",
  "invalid_pin",
  "incorrect_pin",
  "pin_try_exceeded",
  "pin_tries_exceeded",
  "withdrawal_limit_exceeded",
  "withdrawal_frequency_exceeded",
  "new_card_not_unblocked",
  "invalid_account",
  "authentication_required",
  "3ds_challenge_failed",
  "3ds_challenge_failed_manually",
  "customer_challenge_failed",
]);

/** Customer abandoned / rejected the challenge — a cancellation, never a decline. */
export const PAYMENT_CANCELLATION_REASONS: ReadonlySet<string> = new Set([
  "3ds_challenge_abandoned",
  "customer_challenge_abandoned",
  "rejected_by_customer",
]);

/**
 * Canonical snake_case form: `doNotHonour` / `DO-NOT-HONOR` / `threeDSChallengeFailed`
 * → `do_not_honour` / `do_not_honor` / `3ds_challenge_failed`.
 */
export function normalizeDeclineReason(raw: string | null | undefined): string {
  return String(raw ?? "")
    .trim()
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s\-]+/g, "_")
    .toLowerCase()
    .replace(/(^|_)(?:three|3)_?ds(?=_|$)/g, "$13ds");
}

function reasonTokens(parts: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const part of parts) {
    for (const token of String(part ?? "").split(/[^A-Za-z0-9_\-]+/)) {
      const normalized = normalizeDeclineReason(token);
      if (normalized) out.push(normalized);
    }
  }
  return out;
}

/** First bank/issuer/card decline reason found in the inputs, canonicalised; else null. */
export function findBankDeclineReason(
  ...parts: Array<string | null | undefined>
): string | null {
  return reasonTokens(parts).find((token) => BANK_DECLINE_REASONS.has(token)) ?? null;
}

export function isPaymentCancellationReason(
  ...parts: Array<string | null | undefined>
): boolean {
  return reasonTokens(parts).some((token) => PAYMENT_CANCELLATION_REASONS.has(token));
}

const PROVIDER_TOKEN = /^[A-Za-z0-9_:\-]+$/;

/** True only for a bare provider reason/code (e.g. `REVOLUT_PAYMENT_FAILED:do_not_honour`). */
export function isRevolutIssuerCardDeclineReason(raw: string | null | undefined): boolean {
  const token = String(raw ?? "").trim();
  if (!token || !PROVIDER_TOKEN.test(token)) return false;
  return findBankDeclineReason(token) !== null;
}

export function humanizeRevolutPreauthCustomerError(raw: string | null | undefined): string {
  const msg = (raw ?? "").trim();
  if (!msg) return FRIENDLY_DEFAULT;

  const lower = msg.toLowerCase();

  // Bare provider codes/states (decline_reason, payment/order state, internal codes).
  if (PROVIDER_TOKEN.test(msg)) {
    if (isRevolutIssuerCardDeclineReason(msg)) return REVOLUT_CARD_DECLINED_CUSTOMER_MESSAGE;
    if (lower === "cancelled" || lower === "canceled" || isPaymentCancellationReason(msg)) {
      return FRIENDLY_CANCELLED;
    }
    if (lower === "timeout") return FRIENDLY_TIMEOUT;
    if (/declin|fail|error|risk|fraud|challenge|invalid|reject|unavailable|not_available|missing|mismatch/.test(lower)) {
      return REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE;
    }
    return FRIENDLY_DEFAULT;
  }

  if (lower.includes("not configured") || lower.includes("secret")) {
    return FRIENDLY_NOT_CONFIGURED;
  }
  if (lower.includes("token missing") || lower.includes("checkout token")) {
    return "Payment setup failed. Please try again.";
  }
  if (
    lower.includes("requested resource is not found")
    || lower.includes("resource is not found")
    || lower.includes("resource not found")
    || lower.includes("endpoint not found")
  ) {
    return REVOLUT_PAYMENT_SETUP_FAILED_MESSAGE;
  }
  if (lower.includes("declined") || lower.includes("failed") || lower.includes("suspicious")) {
    return REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE;
  }
  if (lower.includes("cancel")) {
    return FRIENDLY_CANCELLED;
  }
  if (lower.includes("not authorized") || lower.includes("not authorised")) {
    return FRIENDLY_NOT_AUTHORISED;
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("network")) {
    return FRIENDLY_TIMEOUT;
  }

  // Never expose raw API / vault / internal diagnostics to customers.
  if (
    lower.includes("http ")
    || lower.includes("sk_")
    || lower.includes("vault")
    || lower.includes("api key")
    || lower.includes("revolut")
    || lower.includes("error")
    || lower.includes("exception")
    || lower.includes("invariant")
    || lower.includes("[object")
  ) {
    return FRIENDLY_DEFAULT;
  }

  return msg.length > 160 ? FRIENDLY_DEFAULT : msg;
}

export function humanizeRevolutBookingCustomerError(raw: string | null | undefined): string {
  const msg = humanizeRevolutPreauthCustomerError(raw);
  if (msg === FRIENDLY_DEFAULT || msg === FRIENDLY_NOT_AUTHORISED) {
    return "We're confirming your payment. Please do not pay again.";
  }
  return msg;
}

export const REVOLUT_BOOKING_FAILED_MESSAGE =
  "Payment received. We're recovering your booking.";
