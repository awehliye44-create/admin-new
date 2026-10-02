export const NEGOTIATION_PAYABLE_INSUFFICIENT_CODE = "PAYMENT_AUTHORISATION_INSUFFICIENT";
export const NEGOTIATION_PAYABLE_INSUFFICIENT_MESSAGE =
  "Payment authorisation is insufficient for this fare";
export const NEGOTIATION_RECONCILIATION_PENDING_CODE = "AUTHORISATION_RECONCILIATION_PENDING";
export const NEGOTIATION_RECONCILIATION_PENDING_MESSAGE =
  "Could not confirm payment authorisation. Please try again.";
export const NEGOTIATION_PERSIST_FAILED_CODE = "PAYMENT_STATE_PERSIST_FAILED";
export const NEGOTIATION_PERSIST_FAILED_MESSAGE =
  "Could not update this fare offer.";

const CARD_LIKE_METHODS = new Set(["CARD", "APPLE_PAY", "GOOGLE_PAY"]);

export function isCardLikePaymentMethod(method: string | null | undefined): boolean {
  return CARD_LIKE_METHODS.has(String(method ?? "").trim().toUpperCase());
}

export function mapNegotiationCoverFailure(input: {
  errorCode?: string | null;
  error?: string | null;
  status?: number | null;
}): { code: string; message: string; status: number } {
  const raw = `${input.errorCode ?? ""} ${input.error ?? ""}`.toUpperCase();
  if (
    raw.includes("CUSTOMER_ACTION_REQUIRED")
    || raw.includes("REAUTH")
    || raw.includes("REQUIRES_REVOLUT_CHECKOUT")
  ) {
    return {
      code: "PAYMENT_REAUTH_REQUIRED",
      message: "Additional payment confirmation is required for this fare",
      status: 402,
    };
  }
  if (
    raw.includes("INCREMENT_CONFIRM_PERSIST_FAILED")
    || raw.includes("PERSIST_FAILED")
    || raw.includes("PAYMENT_STATE_PERSIST")
  ) {
    return {
      code: NEGOTIATION_PERSIST_FAILED_CODE,
      message: NEGOTIATION_PERSIST_FAILED_MESSAGE,
      status: 500,
    };
  }
  if (
    raw.includes("AUTHORISATION_RECONCILIATION_PENDING")
    || raw.includes("INCREMENT_PENDING_UNKNOWN")
    || raw.includes("RETRIEVE_FAILED")
    || raw.includes("AUTHORISED_TOTAL_NOT_INCREASED")
    || raw.includes("PROCESSING")
    || raw.includes("LOCK_BUSY")
    || raw.includes("OPERATION_BUSY")
    || raw.includes("RETRYABLE")
  ) {
    return {
      code: NEGOTIATION_RECONCILIATION_PENDING_CODE,
      message: NEGOTIATION_RECONCILIATION_PENDING_MESSAGE,
      status: 409,
    };
  }
  if (
    raw.includes("AUTHORISED_TOTAL_BELOW_TARGET")
    || raw.includes("DECLINED")
    || raw.includes("PAYMENT_AUTHORISATION_INSUFFICIENT")
  ) {
    return {
      code: NEGOTIATION_PAYABLE_INSUFFICIENT_CODE,
      message: NEGOTIATION_PAYABLE_INSUFFICIENT_MESSAGE,
      status: input.status && input.status >= 400 && input.status < 500 ? input.status : 409,
    };
  }
  if (
    raw.includes("UNSUPPORTED")
    || raw.includes("PROVIDER_INCREMENT_LIMIT")
    || raw.includes("INELIGIBLE")
  ) {
    return {
      code: "PAYMENT_INCREMENT_UNSUPPORTED",
      message: NEGOTIATION_PERSIST_FAILED_MESSAGE,
      status: 409,
    };
  }
  return {
    code: NEGOTIATION_RECONCILIATION_PENDING_CODE,
    message: NEGOTIATION_RECONCILIATION_PENDING_MESSAGE,
    status: input.status && input.status >= 400 && input.status < 500 ? input.status : 409,
  };
}

export function isPaymentGateAcceptFailure(message: string | null | undefined): boolean {
  const text = String(message ?? "");
  return (
    text.includes("PAYMENT_AUTHORISATION_INSUFFICIENT")
    || text.includes("PAYMENT_GATE_NOT_SATISFIED")
    || text.includes("PAYMENT_REAUTH_REQUIRED")
    || text.includes("AUTHORISATION_RECONCILIATION_PENDING")
    || text.includes("PAYMENT_STATE_PERSIST_FAILED")
  );
}
