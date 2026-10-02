/**
 * Canonical modification additional-authorisation failure classes.
 * Shared by Edge responses → Customer App copy mapping.
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

export function failureClassFromGateReason(
  reason: string | null | undefined,
  phase?: string | null,
): ModificationPaymentFailureClass {
  const r = String(reason ?? "").toLowerCase();
  const p = String(phase ?? "").toUpperCase();
  if (r === "declined") return "ISSUER_DECLINED";
  if (r === "insufficient") return "INSUFFICIENT_FUNDS";
  if (r === "timeout" || r === "network") return "NETWORK_OR_TIMEOUT";
  if (r === "processing" || r === "unknown") return "NETWORK_OR_TIMEOUT";
  if (r === "amount_mismatch") return "UNKNOWN_PROVIDER_ERROR";
  if (r === "failed") return "UNKNOWN_PROVIDER_ERROR";
  if (p === "PAYMENT_PENDING") return "NETWORK_OR_TIMEOUT";
  return "UNKNOWN_PROVIDER_ERROR";
}

export function customerSafeErrorForFailureClass(
  failureClass: ModificationPaymentFailureClass,
): string {
  switch (failureClass) {
    case "ISSUER_DECLINED":
      return "Your bank declined the additional payment. Your trip has not been changed.";
    case "INSUFFICIENT_FUNDS":
      return "Insufficient funds for this trip change. Please use another payment method. Your trip has not been changed.";
    case "AUTHENTICATION_FAILED":
      return "Payment authentication wasn't completed. Your trip was not changed.";
    case "CUSTOMER_CANCELLED":
      return "Payment was cancelled. Your trip was not changed.";
    case "NETWORK_OR_TIMEOUT":
      return "We couldn't confirm the additional payment. Your trip was not changed. Please try again.";
    case "ONECAB_BACKEND_ERROR":
      return "We couldn’t complete this trip change. Your trip was not changed. Please try again.";
    case "UNKNOWN_PROVIDER_ERROR":
    default:
      return "We couldn’t complete the additional payment for this change. Your trip was not changed. Please try again.";
  }
}
