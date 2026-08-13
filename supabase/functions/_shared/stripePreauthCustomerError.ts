export const CUSTOMER_PAYMENT_AUTH_FAILED_MESSAGE =
  "We couldn't authorise your payment at the moment. No booking has been created. Please try again in a moment or choose another payment method.";

type StripeLikeError = {
  type?: string;
  code?: string;
  message?: string;
  raw?: { type?: string; code?: string; message?: string };
};

export function extractStripeErrorDetails(err: unknown): {
  type: string | null;
  code: string | null;
  message: string;
} {
  const stripeErr = err as StripeLikeError;
  const message =
    stripeErr.message ??
    stripeErr.raw?.message ??
    (err instanceof Error ? err.message : String(err));
  return {
    type: stripeErr.type ?? stripeErr.raw?.type ?? null,
    code: stripeErr.code ?? stripeErr.raw?.code ?? null,
    message,
  };
}

/** Stripe rejects `request_incremental_authorization` when Flexible Payments is not enrolled. */
export function isStripeFlexiblePaymentsIneligibleError(message: string, code?: string | null): boolean {
  const normalized = message.toLowerCase();
  if (/not eligible for the requested card features/i.test(message)) return true;
  if (/flexible.payments/i.test(message)) return true;
  if (code === "payment_intent_invalid_parameter_value") return true;
  return false;
}

/** Map internal Stripe failures to customer-safe booking preauth copy; log raw message server-side only. */
export function humanizeStripePreauthCustomerError(
  rawMessage: string,
  code?: string | null,
): string {
  if (isStripeFlexiblePaymentsIneligibleError(rawMessage, code)) {
    return CUSTOMER_PAYMENT_AUTH_FAILED_MESSAGE;
  }
  if (/stripe\.com\/docs/i.test(rawMessage)) {
    return CUSTOMER_PAYMENT_AUTH_FAILED_MESSAGE;
  }
  if (
    code === "card_declined"
    || code === "insufficient_funds"
    || code === "expired_card"
    || code === "incorrect_cvc"
    || /card was declined|insufficient funds|expired/i.test(rawMessage)
  ) {
    return "Payment failed. Please choose another card or add a new card.";
  }
  return CUSTOMER_PAYMENT_AUTH_FAILED_MESSAGE;
}
