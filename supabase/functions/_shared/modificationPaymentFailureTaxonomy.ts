/**
 * Canonical modification additional-authorisation failure classes.
 * Structured field on Edge responses; customer copy comes from the unified
 * bank-decline copy in executeFareIncreaseModificationPayment, never from here.
 */

export const MODIFICATION_PAYMENT_FAILURE_CLASSES = [
  "ISSUER_DECLINED",
  "INSUFFICIENT_FUNDS",
  "AUTHENTICATION_FAILED",
  "CUSTOMER_CANCELLED",
  "NETWORK_OR_TIMEOUT",
  "ONECAB_BACKEND_ERROR",
  "UNKNOWN_PROVIDER_ERROR",
] as const;

export type ModificationPaymentFailureClass =
  (typeof MODIFICATION_PAYMENT_FAILURE_CLASSES)[number];

/**
 * Issuer classes only when the provider gave an issuer/card reason
 * (bankDeclineReason from findBankDeclineReason). A bare gate "declined"
 * without a bank reason is never reported as ISSUER_DECLINED.
 */
export function failureClassForModificationFailure(args: {
  pending: boolean;
  kind: "bank_declined" | "not_authorised" | "technical";
  bankDeclineReason: string | null;
}): ModificationPaymentFailureClass {
  if (args.pending) return "NETWORK_OR_TIMEOUT";
  if (args.kind === "bank_declined") {
    return args.bankDeclineReason === "insufficient_funds"
      ? "INSUFFICIENT_FUNDS"
      : "ISSUER_DECLINED";
  }
  return "UNKNOWN_PROVIDER_ERROR";
}
