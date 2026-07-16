/**
 * Slice 12 — Revolut COMPLETED → company funding hold consumption + exactly-once debit.
 * Only canonical provider state `completed` may finalise. Never forge completion.
 * LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED stays false in proof (no auto execution).
 */

export const SLICE12_COMPLETION = 12 as const;

export const COMPLETION_ERROR = {
  PROVIDER_NOT_COMPLETED: "PROVIDER_NOT_COMPLETED",
  PROVIDER_STATE_FORBIDDEN: "PROVIDER_STATE_FORBIDDEN",
  MISSING_PROVIDER_PAYMENT_ID: "MISSING_PROVIDER_PAYMENT_ID",
  PROVIDER_PAYMENT_ID_MISMATCH: "PROVIDER_PAYMENT_ID_MISMATCH",
  TRANSFER_NOT_SUBMITTED: "TRANSFER_NOT_SUBMITTED",
  HOLD_NOT_ACTIVE: "HOLD_NOT_ACTIVE",
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  ALREADY_APPLIED: "ALREADY_APPLIED",
  INVARIANT_PARTIAL_STATE: "INVARIANT_PARTIAL_STATE",
  LIVE_COMPANY_TRANSFER_FORBIDDEN: "LIVE_COMPANY_TRANSFER_EXECUTION_DISABLED",
  LIVE_PAYOUT_AUTOMATIC_FORBIDDEN: "LIVE_PAYOUT_AUTOMATIC_EXECUTION_FORBIDDEN",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  STATUS_SYNC_FAILED: "STATUS_SYNC_FAILED",
  RELAY_UNREACHABLE: "RELAY_UNREACHABLE",
  ACCESS_TOKEN_REQUIRED: "ACCESS_TOKEN_REQUIRED",
} as const;

export type CompanyTransferCompletionErrorCode =
  (typeof COMPLETION_ERROR)[keyof typeof COMPLETION_ERROR];

export const REVOLUT_TRANSACTION_STATES = {
  CREATED: "created",
  PENDING: "pending",
  COMPLETED: "completed",
  DECLINED: "declined",
  FAILED: "failed",
  REVERTED: "reverted",
} as const;

export const NON_FINALISING_PROVIDER_STATES = new Set([
  "created",
  "pending",
  "submitted",
  "processing",
  "failed",
  "declined",
  "cancelled",
  "canceled",
  "reverted",
  "unknown",
  "",
]);

export const SLICE12_LEDGER_DEBIT_TYPE = "COMPANY_TRANSFER" as const;

export const ADMIN_SLICE12_COMPLETION_LABELS = {
  PAID: "Paid",
  HOLD_CONSUMED: "Company funding hold consumed",
  DEBIT_APPLIED: "Company debit applied",
  PROVIDER_COMPLETED: "Provider completed",
  PROVIDER_PENDING: "Provider pending",
  NOT_YET_COMPLETED: "Not yet completed at provider",
} as const;

export function normalizeProviderState(state: string | null | undefined): string {
  return String(state ?? "").trim().toLowerCase();
}

export function isCanonicalProviderCompleted(state: string | null | undefined): boolean {
  return normalizeProviderState(state) === REVOLUT_TRANSACTION_STATES.COMPLETED;
}

export function mayFinaliseCompanyTransferFromProviderState(
  state: string | null | undefined,
): { ok: true } | { ok: false; code: CompanyTransferCompletionErrorCode; message: string } {
  const s = normalizeProviderState(state);
  if (s === REVOLUT_TRANSACTION_STATES.COMPLETED) return { ok: true };
  if (NON_FINALISING_PROVIDER_STATES.has(s) || s.length > 0) {
    return {
      ok: false,
      code: COMPLETION_ERROR.PROVIDER_NOT_COMPLETED,
      message: `Provider state '${s || "unknown"}' must never consume hold or debit company funds`,
    };
  }
  return {
    ok: false,
    code: COMPLETION_ERROR.PROVIDER_NOT_COMPLETED,
    message: "Provider state missing — must never forge completion",
  };
}

export function evaluateSlice12CompletionFlagGate(env: {
  get(key: string): string | undefined;
}): { ok: true } | { ok: false; code: CompanyTransferCompletionErrorCode; message: string } {
  const livePayout =
    (env.get("LIVE_PAYOUT_EXECUTION_ENABLED") ?? "false").trim().toLowerCase() === "true";
  if (livePayout) {
    return {
      ok: false,
      code: COMPLETION_ERROR.LIVE_PAYOUT_AUTOMATIC_FORBIDDEN,
      message: "LIVE_PAYOUT_EXECUTION_ENABLED must stay false for Slice 12 finalisation",
    };
  }
  return { ok: true };
}

export function completionDebitIdempotencyKey(providerPaymentId: string): string {
  return `revolut-company-transfer-completion:${String(providerPaymentId).trim()}`;
}

export function completionLedgerDescription(args: {
  transfer_id: string;
  provider_payment_id: string;
  hold_id?: string | null;
}): string {
  const hold = args.hold_id ? ` hold=${args.hold_id}` : "";
  return (
    `Revolut company transfer completion transfer=${args.transfer_id}` +
    ` payment=${args.provider_payment_id}${hold}`
  );
}

export function evaluateCompanyTransferCompletionEligibility(args: {
  transfer_status: string | null | undefined;
  intent_status: string | null | undefined;
  hold_status: string | null | undefined;
  transfer_amount_pence: number;
  hold_amount_pence: number | null | undefined;
  intent_amount_pence: number | null | undefined;
  currency: string | null | undefined;
  intent_currency?: string | null;
  hold_currency?: string | null;
  intent_provider_payment_id?: string | null;
  requested_provider_payment_id?: string | null;
  financially_applied?: boolean;
  hold_consumed?: boolean;
}): { ok: true } | { ok: false; code: CompanyTransferCompletionErrorCode; message: string } {
  if (args.financially_applied && args.hold_consumed) {
    return { ok: false, code: COMPLETION_ERROR.ALREADY_APPLIED, message: "Completion already applied" };
  }
  const transferStatus = String(args.transfer_status ?? "").toUpperCase();
  if (!["PROCESSING", "PAID", "COMPLETED", "UNKNOWN"].includes(transferStatus)) {
    return {
      ok: false,
      code: COMPLETION_ERROR.TRANSFER_NOT_SUBMITTED,
      message: `Transfer status ${transferStatus || "null"} not eligible for completion`,
    };
  }
  const intentStatus = String(args.intent_status ?? "").toUpperCase();
  if (!["SUBMITTED", "UNKNOWN", "COMPLETED"].includes(intentStatus)) {
    return {
      ok: false,
      code: COMPLETION_ERROR.TRANSFER_NOT_SUBMITTED,
      message: `Intent status ${intentStatus || "null"} not eligible`,
    };
  }
  const holdStatus = String(args.hold_status ?? "").toUpperCase();
  if (!["ACTIVE", "CONSUMED"].includes(holdStatus)) {
    return {
      ok: false,
      code: COMPLETION_ERROR.HOLD_NOT_ACTIVE,
      message: `Hold status ${holdStatus || "null"} not eligible`,
    };
  }
  const amount = Math.round(Number(args.transfer_amount_pence ?? 0));
  const holdAmt = Math.round(Number(args.hold_amount_pence ?? 0));
  const intentAmt = Math.round(Number(args.intent_amount_pence ?? 0));
  if (amount <= 0 || holdAmt !== amount || intentAmt !== amount) {
    return {
      ok: false,
      code: COMPLETION_ERROR.AMOUNT_MISMATCH,
      message: "Transfer/hold/intent amount mismatch",
    };
  }
  const currency = String(args.currency ?? "GBP").trim().toUpperCase();
  if (currency !== "GBP") {
    return { ok: false, code: COMPLETION_ERROR.CURRENCY_MISMATCH, message: "GBP only" };
  }
  const reqPayId = String(args.requested_provider_payment_id ?? "").trim();
  const intentPayId = String(args.intent_provider_payment_id ?? "").trim();
  if (reqPayId && intentPayId && reqPayId !== intentPayId) {
    return {
      ok: false,
      code: COMPLETION_ERROR.PROVIDER_PAYMENT_ID_MISMATCH,
      message: "provider_payment_id mismatch",
    };
  }
  return { ok: true };
}

export function mapProviderReversalOutcome(args: {
  provider_state: string | null | undefined;
}): {
  transfer_status: "FAILED" | "REVERTED" | "DECLINED";
  release_hold: boolean;
  restore_funding: boolean;
} {
  const s = normalizeProviderState(args.provider_state);
  if (s === REVOLUT_TRANSACTION_STATES.REVERTED) {
    return { transfer_status: "REVERTED", release_hold: true, restore_funding: true };
  }
  if (s === REVOLUT_TRANSACTION_STATES.DECLINED) {
    return { transfer_status: "DECLINED", release_hold: true, restore_funding: true };
  }
  return { transfer_status: "FAILED", release_hold: true, restore_funding: true };
}

export function redactCompanyTransferCompletionEvidence(args: {
  provider_payment_id?: string | null;
  provider_state?: string | null;
  provider_completed_at?: string | null;
  http_status?: number | null;
}): Record<string, unknown> {
  const raw = String(args.provider_payment_id ?? "").trim();
  return {
    provider_payment_id_masked: raw
      ? (raw.length <= 8 ? `${raw.slice(0, 2)}…` : `${raw.slice(0, 4)}…${raw.slice(-4)}`)
      : null,
    provider_state: args.provider_state ?? null,
    provider_completed_at: args.provider_completed_at ?? null,
    http_status: args.http_status ?? null,
    sensitive_payload_stored: false,
  };
}

export function assertSlice12CompletionMoneySafety(args: {
  company_debited?: boolean;
  hold_consumed?: boolean;
  driver_wallet_mutated?: boolean;
  revolut_pay_called?: boolean;
  forged_completed?: boolean;
}): void {
  if (args.forged_completed) throw new Error("SLICE12_INVARIANT: forged completion");
  if (args.revolut_pay_called) throw new Error("SLICE12_INVARIANT: /pay from completion edge");
  if (args.driver_wallet_mutated) throw new Error("SLICE12_INVARIANT: driver wallet mutated");
}
