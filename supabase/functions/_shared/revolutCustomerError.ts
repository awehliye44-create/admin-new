/**
 * Driver-safe / customer-safe Revolut payment error messages.
 */

const FRIENDLY_DEFAULT =
  "We couldn't complete your payment. Please try again or use another payment method.";

const FRIENDLY_NOT_CONFIGURED =
  "Card payments aren't available in this area right now. Please try again later or contact support.";

const FRIENDLY_NOT_AUTHORISED =
  "We're confirming your payment. Please do not pay again.";

const FRIENDLY_CANCELLED =
  "Payment was cancelled. No booking has been created.";

export function humanizeRevolutPreauthCustomerError(raw: string | null | undefined): string {
  const msg = (raw ?? "").trim();
  if (!msg) return FRIENDLY_DEFAULT;

  const lower = msg.toLowerCase();
  if (lower.includes("not configured") || lower.includes("secret")) {
    return FRIENDLY_NOT_CONFIGURED;
  }
  if (lower.includes("token missing") || lower.includes("checkout token")) {
    return "Payment setup failed. Please try again.";
  }
  if (lower.includes("declined") || lower.includes("failed") || lower.includes("suspicious")) {
    return "Your bank or payment provider declined this payment. Please try another card or payment method.";
  }
  if (lower.includes("cancel")) {
    return FRIENDLY_CANCELLED;
  }
  if (lower.includes("not authorized") || lower.includes("not authorised")) {
    return FRIENDLY_NOT_AUTHORISED;
  }
  if (lower.includes("timeout") || lower.includes("network")) {
    return "Payment timed out. Please check your connection and try again.";
  }

  // Never expose raw API / vault diagnostics to customers.
  if (
    lower.includes("http ")
    || lower.includes("sk_")
    || lower.includes("vault")
    || lower.includes("api key")
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
