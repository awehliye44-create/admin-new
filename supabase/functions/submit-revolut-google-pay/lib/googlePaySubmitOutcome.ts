/**
 * Google Pay submit failure → customer response. After the token reaches
 * Revolut, a failure is a card/payment outcome, never a Google Pay wording
 * (unified-bank-decline-copy lock). Bank copy only with an issuer/card reason.
 */
import {
  findBankDeclineReason,
  REVOLUT_CARD_DECLINED_CUSTOMER_MESSAGE,
  REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE,
} from "../../_shared/revolutCustomerError.ts";

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
 * @param revolutHttpStatus Merchant API HTTP status when the pay call itself failed.
 */
export function classifyGooglePaySubmitFailure(args: {
  declineReason: string | null | undefined;
  providerRejected: boolean;
  revolutHttpStatus?: number | null;
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
  if (args.providerRejected || declineReason) {
    return {
      status: 402,
      code: "PAYMENT_NOT_AUTHORISED",
      message: REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE,
      decline_reason: declineReason,
      bank_declined: false,
    };
  }
  // Revolut validation / client errors are definitive — never a 502 "maybe paid" hang.
  const revolutStatus = Number(args.revolutHttpStatus ?? 0);
  if (revolutStatus >= 400 && revolutStatus < 500) {
    return {
      status: 400,
      code: "GOOGLE_PAY_SUBMIT_FAILED",
      message: REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE,
      decline_reason: null,
      bank_declined: false,
    };
  }
  return {
    status: 502,
    code: "GOOGLE_PAY_SUBMIT_FAILED",
    message: REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE,
    decline_reason: null,
    bank_declined: false,
  };
}

/** Extract Revolut Merchant API throw shape (plain object, not Error). */
export function readRevolutApiThrow(err: unknown): {
  message: string;
  status: number | null;
} {
  if (err instanceof Error) {
    return { message: err.message || "pay_failed", status: null };
  }
  if (err && typeof err === "object") {
    const rec = err as { message?: unknown; status?: unknown };
    const message =
      typeof rec.message === "string" && rec.message.trim()
        ? rec.message.trim()
        : "pay_failed";
    const status =
      typeof rec.status === "number" && Number.isFinite(rec.status)
        ? Math.round(rec.status)
        : null;
    return { message, status };
  }
  return { message: "pay_failed", status: null };
}
