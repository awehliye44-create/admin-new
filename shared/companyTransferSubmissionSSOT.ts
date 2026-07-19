/**
 * Slice 12 — controlled Revolut Business provider submission for READY company transfers.
 * REVOLUT_PAYMENT_TRANSPORT_ENABLED=true; LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED=false
 * (fail-closed proof — no /pay, no hold, no debit). Company funding hold stays separate
 * from driver wallet reservations.
 */

import {
  COMPANY_TRANSFER_GATE_REASON,
  evaluateCompanyTransferExecutionGate,
  type CompanyTransferFundingSnapshot,
  type CompanyTransferGateReasonCode,
} from "./companyTransferLifecycleSSOT.ts";

export const SLICE12 = 12 as const;

export const LIVE_COMPANY_TRANSFER_EXECUTION_ENV =
  "LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED" as const;

export const SUBMISSION_ERROR = {
  PAYMENT_TRANSPORT_DISABLED: "PAYMENT_TRANSPORT_DISABLED",
  LIVE_COMPANY_TRANSFER_FORBIDDEN: "LIVE_COMPANY_TRANSFER_EXECUTION_DISABLED",
  LIVE_PAYOUT_AUTOMATIC_FORBIDDEN: "LIVE_PAYOUT_AUTOMATIC_EXECUTION_FORBIDDEN",
  TRANSFER_NOT_READY: "TRANSFER_NOT_READY",
  TRANSFER_ALREADY_SUBMITTED: "TRANSFER_ALREADY_SUBMITTED",
  SUBMISSION_IN_FLIGHT: "SUBMISSION_IN_FLIGHT",
  UNKNOWN_NO_BLIND_RETRY: "UNKNOWN_NO_BLIND_RETRY",
  CLAIM_CONFLICT: "CLAIM_CONFLICT",
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
  PAYEE_NOT_LINKED: "PAYEE_NOT_LINKED",
  PAYEE_UNVERIFIED: "PAYEE_UNVERIFIED",
  MISSING_SOURCE_ACCOUNT: "MISSING_SOURCE_ACCOUNT",
  FUNDING_GATE_BLOCKED: "FUNDING_GATE_BLOCKED",
  ARBITRARY_PAYMENT_BLOCKED: "ARBITRARY_PAYMENT_BLOCKED",
  DRIVER_PAYOUT_BLOCKED: "DRIVER_PAYOUT_BLOCKED",
  ACCESS_TOKEN_REQUIRED: "ACCESS_TOKEN_REQUIRED",
  RELAY_UNREACHABLE: "RELAY_UNREACHABLE",
  PROVIDER_HARD_REJECT: "PROVIDER_HARD_REJECT",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  HOLD_NOT_ACTIVE: "HOLD_NOT_ACTIVE",
} as const;

export type CompanyTransferSubmissionErrorCode =
  (typeof SUBMISSION_ERROR)[keyof typeof SUBMISSION_ERROR];

export const SLICE12_TRANSFER_STATUS = {
  READY_FOR_EXECUTION: "READY_FOR_EXECUTION",
  SUBMITTING: "SUBMITTING",
  PROCESSING: "PROCESSING",
  SUBMITTED: "SUBMITTED",
  FAILED: "FAILED",
  DECLINED: "DECLINED",
  UNKNOWN: "UNKNOWN",
  BLOCKED: "BLOCKED",
} as const;

export const SLICE12_INTENT_STATUS = {
  READY: "READY",
  SUBMITTING: "SUBMITTING",
  SUBMITTED: "SUBMITTED",
  FAILED: "FAILED",
  DECLINED: "DECLINED",
  UNKNOWN: "UNKNOWN",
  COMPLETED: "COMPLETED",
} as const;

export const SLICE12_HOLD_STATUS = {
  ACTIVE: "ACTIVE",
  RELEASED: "RELEASED",
  CONSUMED: "CONSUMED",
} as const;

export const ADMIN_SLICE12_LABELS = {
  READY: "Ready for execution",
  HOLD_ACTIVE: "Company funding hold active",
  HOLD_NOT_PLACED: "No funding hold",
  PROVIDER_SUBMITTED: "Submitted to provider",
  PROVIDER_PENDING: "Provider pending",
  PROVIDER_UNKNOWN: "Provider state unknown",
  PROVIDER_FAILED: "Provider submission failed",
  NOT_DEBITED: "Company debit not applied",
  NOT_PAID: "Not paid",
} as const;

export const SLICE12_PROOF = {
  PROOF_TRANSFER_ID: "4d350ba2-93e6-4e45-80c9-e02bfcf2796b",
  SOURCE_PENCE: 1526,
  AHMED_RESERVED_PENCE: 1001,
  BOSTEYO_COMPLETED_PENCE: 408,
} as const;

/** Revolut POST /pay request_id max length. Format: oc-ct:{uuidhex} = 38. */
export const REVOLUT_PAY_REQUEST_ID_MAX_LEN = 40;

export function canonicalCompanyTransferProviderRequestId(transferId: string): string {
  const hex = String(transferId ?? "").trim().toLowerCase().replace(/-/g, "");
  const id = `oc-ct:${hex}`;
  if (id.length > REVOLUT_PAY_REQUEST_ID_MAX_LEN) {
    throw new Error(
      `provider_request_id length ${id.length} exceeds Revolut max ${REVOLUT_PAY_REQUEST_ID_MAX_LEN}`,
    );
  }
  return id;
}

export function canonicalCompanyTransferIdempotencyKey(transferId: string): string {
  return canonicalCompanyTransferProviderRequestId(transferId);
}

export function maySubmitCompanyTransferViaTransport(env: {
  get(key: string): string | undefined;
}): boolean {
  const transport =
    (env.get("REVOLUT_PAYMENT_TRANSPORT_ENABLED") ?? "false").trim().toLowerCase() === "true";
  const liveCompany =
    (env.get(LIVE_COMPANY_TRANSFER_EXECUTION_ENV) ?? "false").trim().toLowerCase() === "true";
  // Independent of driver LIVE_PAYOUT — company and driver money paths are isolated.
  return transport && liveCompany;
}

export function evaluateSlice12SubmissionFlagGate(env: {
  get(key: string): string | undefined;
}): { ok: true } | { ok: false; code: CompanyTransferSubmissionErrorCode; message: string } {
  const transport =
    (env.get("REVOLUT_PAYMENT_TRANSPORT_ENABLED") ?? "false").trim().toLowerCase() === "true";
  if (!transport) {
    return {
      ok: false,
      code: SUBMISSION_ERROR.PAYMENT_TRANSPORT_DISABLED,
      message: "REVOLUT_PAYMENT_TRANSPORT_ENABLED must be true for company transfer transport",
    };
  }
  return { ok: true };
}

export function rejectDriverOrArbitraryPayment(body: Record<string, unknown>):
  | { ok: true }
  | { ok: false; code: CompanyTransferSubmissionErrorCode; message: string } {
  if (body.payout_item_id || body.driver_id || body.payout_destination_id) {
    return {
      ok: false,
      code: SUBMISSION_ERROR.DRIVER_PAYOUT_BLOCKED,
      message: "Driver payout fields blocked on company transfer submission",
    };
  }
  if (body.arbitrary_payment === true || body.raw_pay === true || body.revolut_path) {
    return {
      ok: false,
      code: SUBMISSION_ERROR.ARBITRARY_PAYMENT_BLOCKED,
      message: "Arbitrary / raw Revolut payments are blocked",
    };
  }
  return { ok: true };
}

export function evaluateCompanyTransferSubmissionEligibility(args: {
  transfer_status: string | null | undefined;
  intent_status?: string | null;
  hold_status?: string | null;
  approved_amount_pence: number;
  loaded_amount_pence: number;
  payee_verified?: boolean | null;
  provider_counterparty_id?: string | null;
  provider_recipient_account_id?: string | null;
}): { ok: true } | { ok: false; code: CompanyTransferSubmissionErrorCode; message: string } {
  const status = String(args.transfer_status ?? "").toUpperCase();
  if (!["READY_FOR_EXECUTION", "PROCESSING"].includes(status)) {
    if (status === "SUBMITTING" || status === "SUBMITTED") {
      return {
        ok: false,
        code: SUBMISSION_ERROR.TRANSFER_ALREADY_SUBMITTED,
        message: "Transfer already submitted to provider",
      };
    }
    return {
      ok: false,
      code: SUBMISSION_ERROR.TRANSFER_NOT_READY,
      message: `Transfer status ${status || "null"} is not READY_FOR_EXECUTION`,
    };
  }
  const intent = String(args.intent_status ?? "").toUpperCase();
  if (intent === "SUBMITTED" || intent === "COMPLETED") {
    return {
      ok: false,
      code: SUBMISSION_ERROR.TRANSFER_ALREADY_SUBMITTED,
      message: "Payment intent already submitted",
    };
  }
  if (intent === "SUBMITTING") {
    return {
      ok: false,
      code: SUBMISSION_ERROR.SUBMISSION_IN_FLIGHT,
      message: "Submission already in flight",
    };
  }
  if (intent === "UNKNOWN") {
    return {
      ok: false,
      code: SUBMISSION_ERROR.UNKNOWN_NO_BLIND_RETRY,
      message: "Prior UNKNOWN — no blind retry",
    };
  }
  const approved = Math.round(Number(args.approved_amount_pence ?? 0));
  const loaded = Math.round(Number(args.loaded_amount_pence ?? 0));
  if (approved <= 0 || loaded <= 0 || approved !== loaded) {
    return {
      ok: false,
      code: SUBMISSION_ERROR.AMOUNT_MISMATCH,
      message: "Approved amount must match server-loaded transfer amount",
    };
  }
  if (args.payee_verified === false) {
    return {
      ok: false,
      code: SUBMISSION_ERROR.PAYEE_UNVERIFIED,
      message: "Payee must be verified before provider submission",
    };
  }
  if (!args.provider_counterparty_id || !args.provider_recipient_account_id) {
    return {
      ok: false,
      code: SUBMISSION_ERROR.PAYEE_NOT_LINKED,
      message: "Payee missing Revolut counterparty/recipient linkage",
    };
  }
  return { ok: true };
}

export function evaluateCompanyTransferPreSubmitGate(args: {
  amount_pence: number;
  funding_snapshot: CompanyTransferFundingSnapshot;
  live_company_transfer_execution_enabled: boolean;
}): {
  allowed: boolean;
  reason_codes: CompanyTransferGateReasonCode[];
  funding_snapshot: CompanyTransferFundingSnapshot;
} {
  return evaluateCompanyTransferExecutionGate({
    amount_pence: args.amount_pence,
    funding_snapshot: args.funding_snapshot,
    live_company_transfer_execution_enabled: args.live_company_transfer_execution_enabled,
  });
}

export function mapCompanyTransferProviderSubmissionOutcome(args: {
  http_ok: boolean;
  timed_out?: boolean;
  provider_payment_id?: string | null;
  provider_state?: string | null;
  hard_reject?: boolean;
}): {
  execution_status: "SUBMITTED" | "FAILED" | "DECLINED" | "UNKNOWN";
  transfer_status: "PROCESSING" | "FAILED" | "DECLINED" | "UNKNOWN";
  keep_hold_active: boolean;
  release_hold: boolean;
  company_debited: false;
  paid: false;
} {
  if (args.timed_out) {
    return {
      execution_status: "UNKNOWN",
      transfer_status: "UNKNOWN",
      keep_hold_active: true,
      release_hold: false,
      company_debited: false,
      paid: false,
    };
  }
  const state = String(args.provider_state ?? "").trim().toLowerCase();
  if (args.hard_reject || state === "declined") {
    return {
      execution_status: state === "declined" ? "DECLINED" : "FAILED",
      transfer_status: state === "declined" ? "DECLINED" : "FAILED",
      keep_hold_active: false,
      release_hold: true,
      company_debited: false,
      paid: false,
    };
  }
  if (state === "failed" || state === "reverted") {
    return {
      execution_status: "FAILED",
      transfer_status: "FAILED",
      keep_hold_active: false,
      release_hold: true,
      company_debited: false,
      paid: false,
    };
  }
  if (
    args.http_ok
    && (Boolean(args.provider_payment_id) || state === "pending" || state === "completed")
  ) {
    return {
      execution_status: "SUBMITTED",
      transfer_status: "PROCESSING",
      keep_hold_active: true,
      release_hold: false,
      company_debited: false,
      paid: false,
    };
  }
  if (!args.http_ok) {
    return {
      execution_status: "FAILED",
      transfer_status: "FAILED",
      keep_hold_active: false,
      release_hold: true,
      company_debited: false,
      paid: false,
    };
  }
  return {
    execution_status: "UNKNOWN",
    transfer_status: "UNKNOWN",
    keep_hold_active: true,
    release_hold: false,
    company_debited: false,
    paid: false,
  };
}

export function maskProviderId(id: string | null | undefined): string | null {
  const raw = String(id ?? "").trim();
  if (!raw) return null;
  if (raw.length <= 8) return `${raw.slice(0, 2)}…`;
  return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
}

export function redactCompanyTransferSubmissionEvidence(args: {
  provider_payment_id?: string | null;
  provider_state?: string | null;
  provider_request_id?: string | null;
  http_status?: number | null;
  created_at?: string | null;
  failure_code?: string | null;
}): Record<string, unknown> {
  return {
    provider_payment_id_masked: maskProviderId(args.provider_payment_id),
    provider_state: args.provider_state ?? null,
    provider_request_id: args.provider_request_id ?? null,
    http_status: args.http_status ?? null,
    provider_created_at: args.created_at ?? null,
    failure_code: args.failure_code ?? null,
    sensitive_payload_stored: false,
  };
}

export function adminCompanyTransferSubmissionDisplay(args: {
  transfer_status: string;
  hold_status?: string | null;
  provider_state?: string | null;
  provider_payment_id?: string | null;
  blocked_reason_codes?: string[] | null;
}): {
  hold_label: string;
  provider_submission_status: string;
  provider_state: string | null;
  provider_payment_id_masked: string | null;
  blocked_reason_codes: string[];
  paid_label: string;
  debit_label: string;
} {
  const status = String(args.transfer_status ?? "").toUpperCase();
  const holdActive = String(args.hold_status ?? "").toUpperCase() === "ACTIVE";
  let providerStatus = ADMIN_SLICE12_LABELS.READY;
  if (status === "PROCESSING" || status === "SUBMITTED") {
    providerStatus = String(args.provider_state ?? "").toLowerCase() === "pending"
      ? ADMIN_SLICE12_LABELS.PROVIDER_PENDING
      : ADMIN_SLICE12_LABELS.PROVIDER_SUBMITTED;
  } else if (status === "SUBMITTING") {
    providerStatus = "Submitting to provider";
  } else if (status === "UNKNOWN") {
    providerStatus = ADMIN_SLICE12_LABELS.PROVIDER_UNKNOWN;
  } else if (status === "FAILED") {
    providerStatus = ADMIN_SLICE12_LABELS.PROVIDER_FAILED;
  } else if (status === "BLOCKED") {
    providerStatus = "Blocked";
  }
  return {
    hold_label: holdActive
      ? ADMIN_SLICE12_LABELS.HOLD_ACTIVE
      : ADMIN_SLICE12_LABELS.HOLD_NOT_PLACED,
    provider_submission_status: providerStatus,
    provider_state: args.provider_state ?? null,
    provider_payment_id_masked: maskProviderId(args.provider_payment_id),
    blocked_reason_codes: args.blocked_reason_codes ?? [],
    paid_label: ADMIN_SLICE12_LABELS.NOT_PAID,
    debit_label: ADMIN_SLICE12_LABELS.NOT_DEBITED,
  };
}

export function assertSlice12SubmissionMoneySafety(args: {
  company_debited?: boolean;
  hold_consumed?: boolean;
  paid_marked?: boolean;
  live_company_transfer_execution_enabled?: boolean;
  revolut_pay_called?: boolean;
  driver_wallet_mutated?: boolean;
}): void {
  if (args.company_debited) throw new Error("SLICE12_INVARIANT: company debited before completion");
  if (args.hold_consumed) throw new Error("SLICE12_INVARIANT: hold consumed before completion");
  if (args.paid_marked) throw new Error("SLICE12_INVARIANT: marked paid before completion");
  if (args.driver_wallet_mutated) throw new Error("SLICE12_INVARIANT: driver wallet mutated");
  if (!args.live_company_transfer_execution_enabled && args.revolut_pay_called) {
    throw new Error("SLICE12_INVARIANT: /pay called while live company transfer disabled");
  }
}

export { COMPANY_TRANSFER_GATE_REASON };
