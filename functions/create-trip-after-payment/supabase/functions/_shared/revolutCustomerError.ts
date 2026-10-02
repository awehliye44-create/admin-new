/**
 * Driver-safe / customer-safe Revolut payment error messages.
 *
 * Bank/issuer wording only when the input is a Revolut `decline_reason` that
 * Revolut attributes to the card issuer or the card itself. Revolut uses the
 * `declined` and `failed` payment states for technical, risk and data failures
 * too, so a state, generic "failed"/"declined" text, a timeout or an unknown
 * reason always gets neutral copy. Raw provider/internal text is never shown.
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

export const REVOLUT_CARD_DECLINED_CUSTOMER_MESSAGE =
  "Your bank or payment provider declined this payment. Please try another card or payment method.";

export const REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE =
  "We couldn't authorise the payment. Please try again or use another payment method.";

/**
 * Revolut `decline_reason` values attributed to the card issuer or the card
 * (developer.revolut.com, Decline reasons). Excluded on purpose: high_risk and
 * suspected_fraud (may be Revolut's own tools), issuer_not_available and
 * technical_error (technical), 3DS/customer challenge outcomes, and
 * merchant/data validation reasons.
 */
const ISSUER_CARD_DECLINE_REASONS = new Set([
  "do_not_honour",
  "issuer_decline",
  "insufficient_funds",
  "transaction_not_allowed_for_cardholder",
  "restricted_card",
  "withdrawal_limit_exceeded",
  "withdrawal_frequency_exceeded",
  "pick_up_card",
  "lost_card",
  "stolen_card",
  "expired_card",
  "invalid_cvv",
  "invalid_expiry",
  "invalid_pin",
  "pin_try_exceeded",
  "new_card_not_unblocked",
  "invalid_account",
  "invalid_merchant",
]);

const PROVIDER_TOKEN = /^[A-Za-z0-9_:\-]+$/;

export function isRevolutIssuerCardDeclineReason(raw: string | null | undefined): boolean {
  const token = String(raw ?? "").trim();
  if (!token || !PROVIDER_TOKEN.test(token)) return false;
  const reason = token.slice(token.lastIndexOf(":") + 1).toLowerCase();
  return ISSUER_CARD_DECLINE_REASONS.has(reason);
}

export function humanizeRevolutPreauthCustomerError(raw: string | null | undefined): string {
  const msg = (raw ?? "").trim();
  if (!msg) return FRIENDLY_DEFAULT;

  const lower = msg.toLowerCase();

  // Bare provider codes/states (decline_reason, payment/order state, internal codes).
  if (PROVIDER_TOKEN.test(msg)) {
    if (isRevolutIssuerCardDeclineReason(msg)) return REVOLUT_CARD_DECLINED_CUSTOMER_MESSAGE;
    if (lower === "cancelled" || lower === "canceled") return FRIENDLY_CANCELLED;
    if (lower === "timeout") return FRIENDLY_TIMEOUT;
    if (/declin|fail|error|risk|fraud|challenge|invalid|reject|unavailable|not_available/.test(lower)) {
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
