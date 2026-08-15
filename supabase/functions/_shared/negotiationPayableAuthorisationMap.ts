export const NEGOTIATION_PAYABLE_INSUFFICIENT_CODE = "PAYMENT_AUTHORISATION_INSUFFICIENT";
export const NEGOTIATION_PAYABLE_INSUFFICIENT_MESSAGE =
  "Payment authorisation is insufficient for this fare";

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
  return {
    code: NEGOTIATION_PAYABLE_INSUFFICIENT_CODE,
    message: NEGOTIATION_PAYABLE_INSUFFICIENT_MESSAGE,
    status: input.status && input.status >= 400 && input.status < 500 ? input.status : 409,
  };
}

export function isPaymentGateAcceptFailure(message: string | null | undefined): boolean {
  const text = String(message ?? "");
  return (
    text.includes("PAYMENT_AUTHORISATION_INSUFFICIENT")
    || text.includes("PAYMENT_GATE_NOT_SATISFIED")
    || text.includes("PAYMENT_REAUTH_REQUIRED")
  );
}
