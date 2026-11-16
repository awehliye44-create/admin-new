/**
 * Google Pay submit failure → customer response + sanitised provider evidence.
 * After the token reaches Revolut, a failure is a card/payment outcome, never a
 * Google Pay wording (unified-bank-decline-copy lock). Bank copy only with an
 * issuer/card reason.
 *
 * Bug #37: preserve structured Revolut plain-object throws; never swallow as
 * opaque pay_failed / indefinite Checking payment.
 */
import {
  findBankDeclineReason,
  REVOLUT_CARD_DECLINED_CUSTOMER_MESSAGE,
  REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE,
} from "../../_shared/revolutCustomerError.ts";
import { parseRevolutErrorBody } from "../../_shared/revolutApi.ts";

const FAILED_PAYMENT_STATES = new Set(["DECLINED", "SOFT_DECLINED", "FAILED"]);

type PaymentLike = { state?: string | null; decline_reason?: string | null } | null | undefined;

export type GooglePayFailureCategory =
  | "validation"
  | "billing_incomplete"
  | "issuer_decline"
  | "authentication_required"
  | "provider_rejected"
  | "rate_limited"
  | "provider_failure"
  | "network_timeout"
  | "ambiguous";

export type GooglePaySubmitFailure = {
  status: number;
  code:
    | "PAYMENT_DECLINED_BY_BANK"
    | "PAYMENT_NOT_AUTHORISED"
    | "GOOGLE_PAY_SUBMIT_FAILED"
    | "GOOGLE_PAY_BILLING_INCOMPLETE"
    | "PAYMENT_AUTHENTICATION_REQUIRED"
    | "PAYMENT_RATE_LIMITED";
  message: string;
  decline_reason: string | null;
  bank_declined: boolean;
  category: GooglePayFailureCategory;
  /** Ambiguous outcomes must reconcile — never treated as definitive fail/success. */
  ambiguous: boolean;
  revolut_error_code: string | null;
  revolut_message: string | null;
  payment_stage: string;
};

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

export function classifyGooglePaySubmitFailure(args: {
  declineReason: string | null | undefined;
  providerRejected: boolean;
  revolutHttpStatus?: number | null;
  revolutMessage?: string | null;
  revolutErrorCode?: string | null;
  paymentStage?: string;
  authenticationRequired?: boolean;
}): GooglePaySubmitFailure {
  const declineReason = String(args.declineReason ?? "").trim() || null;
  const revolutMessage = String(args.revolutMessage ?? "").trim() || null;
  const revolutErrorCode = String(args.revolutErrorCode ?? "").trim() || null;
  const paymentStage = String(args.paymentStage ?? "pay_for_order").trim() || "pay_for_order";
  const revolutStatus = Number(args.revolutHttpStatus ?? 0);

  if (args.authenticationRequired) {
    return {
      status: 202,
      code: "PAYMENT_AUTHENTICATION_REQUIRED",
      message: REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE,
      decline_reason: declineReason,
      bank_declined: false,
      category: "authentication_required",
      ambiguous: true,
      revolut_error_code: revolutErrorCode,
      revolut_message: revolutMessage,
      payment_stage: paymentStage,
    };
  }

  if (findBankDeclineReason(declineReason)) {
    return {
      status: 402,
      code: "PAYMENT_DECLINED_BY_BANK",
      message: REVOLUT_CARD_DECLINED_CUSTOMER_MESSAGE,
      decline_reason: declineReason,
      bank_declined: true,
      category: "issuer_decline",
      ambiguous: false,
      revolut_error_code: revolutErrorCode,
      revolut_message: revolutMessage,
      payment_stage: paymentStage,
    };
  }

  if (args.providerRejected || declineReason) {
    return {
      status: 402,
      code: "PAYMENT_NOT_AUTHORISED",
      message: REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE,
      decline_reason: declineReason,
      bank_declined: false,
      category: "provider_rejected",
      ambiguous: false,
      revolut_error_code: revolutErrorCode,
      revolut_message: revolutMessage,
      payment_stage: paymentStage,
    };
  }

  if (revolutStatus === 429) {
    return {
      status: 429,
      code: "PAYMENT_RATE_LIMITED",
      message: REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE,
      decline_reason: null,
      bank_declined: false,
      category: "rate_limited",
      ambiguous: true,
      revolut_error_code: revolutErrorCode,
      revolut_message: revolutMessage,
      payment_stage: paymentStage,
    };
  }

  // Revolut validation / client errors are definitive — never a 502 "maybe paid" hang.
  if (revolutStatus >= 400 && revolutStatus < 500 && revolutStatus !== 408) {
    return {
      status: 400,
      code: "GOOGLE_PAY_SUBMIT_FAILED",
      message: REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE,
      decline_reason: null,
      bank_declined: false,
      category: "validation",
      ambiguous: false,
      revolut_error_code: revolutErrorCode,
      revolut_message: revolutMessage,
      payment_stage: paymentStage,
    };
  }

  if (revolutStatus === 408 || revolutStatus === 0) {
    return {
      status: 502,
      code: "GOOGLE_PAY_SUBMIT_FAILED",
      message: REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE,
      decline_reason: null,
      bank_declined: false,
      category: revolutStatus === 408 ? "network_timeout" : "ambiguous",
      ambiguous: true,
      revolut_error_code: revolutErrorCode,
      revolut_message: revolutMessage,
      payment_stage: paymentStage,
    };
  }

  if (revolutStatus >= 500) {
    return {
      status: 502,
      code: "GOOGLE_PAY_SUBMIT_FAILED",
      message: REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE,
      decline_reason: null,
      bank_declined: false,
      category: "provider_failure",
      // 502 alone is ambiguous without order retrieve evidence.
      ambiguous: true,
      revolut_error_code: revolutErrorCode,
      revolut_message: revolutMessage,
      payment_stage: paymentStage,
    };
  }

  return {
    status: 502,
    code: "GOOGLE_PAY_SUBMIT_FAILED",
    message: REVOLUT_PAYMENT_NOT_AUTHORISED_CUSTOMER_MESSAGE,
    decline_reason: null,
    bank_declined: false,
    category: "ambiguous",
    ambiguous: true,
    revolut_error_code: revolutErrorCode,
    revolut_message: revolutMessage,
    payment_stage: paymentStage,
  };
}

/** Extract Revolut Merchant API throw shape (plain object, not Error). */
export function readRevolutApiThrow(err: unknown): {
  message: string;
  status: number | null;
  revolut_error_code: string | null;
  body: unknown;
} {
  if (err instanceof Error) {
    return {
      message: err.message || "pay_failed",
      status: null,
      revolut_error_code: null,
      body: null,
    };
  }
  if (err && typeof err === "object") {
    const rec = err as { message?: unknown; status?: unknown; body?: unknown };
    const parsed = parseRevolutErrorBody(rec.body);
    const message =
      (typeof rec.message === "string" && rec.message.trim()) ||
      parsed.revolut_message ||
      "pay_failed";
    const status =
      typeof rec.status === "number" && Number.isFinite(rec.status)
        ? Math.round(rec.status)
        : null;
    return {
      message,
      status,
      revolut_error_code: parsed.revolut_error_code,
      body: rec.body ?? null,
    };
  }
  return { message: "pay_failed", status: null, revolut_error_code: null, body: null };
}
