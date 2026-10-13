/**
 * Google Pay submit failure → customer response. After the token reaches
 * Revolut, a failure is a card/payment outcome, never a Google Pay wording
 * (unified-bank-decline-copy lock). Bank copy only with an issuer/card reason.
 */
import {
  findBankDeclineReason,
  REVOLUT_CARD_DECLINED_CUSTOMER_MESSAGE,
  REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE,
} from "./revolutCustomerError.ts";

const FAILED_PAYMENT_STATES = new Set(["DECLINED", "SOFT_DECLINED", "FAILED"]);

type PaymentLike = { state?: string | null; decline_reason?: string | null } | null | undefined;

export function isFailedPaymentState(state: string | null | undefined): boolean {
  return FAILED_PAYMENT_STATES.has(String(state ?? "").trim().toUpperCase());
}

/** Most recent failed/declined payment's `decline_reason` (Revolut lists payments oldest first). */
export function latestFailedPaymentDeclineReason(
  payments: PaymentLike[] | null | undefined,
): string | null {
  const list = Array.isArray(payments) ? payments : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const payment = list[i];
    if (!payment || !isFailedPaymentState(payment.state)) continue;
    const reason = String(payment.decline_reason ?? "").trim();
    return reason || null;
  }
  return null;
}

export type GooglePaySubmitFailure = {
  status: number;
  code: "PAYMENT_DECLINED_BY_BANK" | "PAYMENT_NOT_AUTHORISED" | "GOOGLE_PAY_SUBMIT_FAILED";
  message: string;
  decline_reason: string | null;
  bank_declined: boolean;
};

/**
 * @param providerRejected true when Revolut returned a failed/declined payment;
 *   false when the submit call itself errored (no provider outcome known).
 */
export function classifyGooglePaySubmitFailure(args: {
  declineReason: string | null | undefined;
  providerRejected: boolean;
}): GooglePaySubmitFailure {
  const declineReason = String(args.declineReason ?? "").trim() || null;
  if (findBankDeclineReason(declineReason)) {
    return {
      status: 402,
      code: "PAYMENT_DECLINED_BY_BANK",
      message: REVOLUT_CARD_DECLINED_CUSTOMER_MESSAGE,
      decline_reason: declineReason,
      bank_declined: true,
    };
  }
  return {
    status: args.providerRejected || declineReason ? 402 : 502,
    code: args.providerRejected || declineReason ? "PAYMENT_NOT_AUTHORISED" : "GOOGLE_PAY_SUBMIT_FAILED",
    message: REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE,
    decline_reason: declineReason,
    bank_declined: false,
  };
}
