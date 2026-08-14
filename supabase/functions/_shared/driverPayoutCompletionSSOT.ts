/**
 * Edge copy of shared/driverPayoutCompletionSSOT.ts (Slice 8).
 * Keep in sync with shared/driverPayoutCompletionSSOT.ts.
 */

export const SLICE8 = 8 as const;

export const COMPLETION_ERROR = {
  PROVIDER_NOT_COMPLETED: "PROVIDER_NOT_COMPLETED",
  PROVIDER_STATE_FORBIDDEN: "PROVIDER_STATE_FORBIDDEN",
  MISSING_PROVIDER_PAYMENT_ID: "MISSING_PROVIDER_PAYMENT_ID",
  PROVIDER_PAYMENT_ID_MISMATCH: "PROVIDER_PAYMENT_ID_MISMATCH",
  PAYOUT_ITEM_NOT_SUBMITTED: "PAYOUT_ITEM_NOT_SUBMITTED",
  RESERVATION_NOT_ACTIVE: "RESERVATION_NOT_ACTIVE",
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  DRIVER_MISMATCH: "DRIVER_MISMATCH",
  ALREADY_APPLIED: "ALREADY_APPLIED",
  INVARIANT_PARTIAL_STATE: "INVARIANT_PARTIAL_STATE",
  LIVE_AUTOMATIC_EXECUTION_FORBIDDEN: "LIVE_AUTOMATIC_EXECUTION_FORBIDDEN",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  STATUS_SYNC_FAILED: "STATUS_SYNC_FAILED",
  RELAY_UNREACHABLE: "RELAY_UNREACHABLE",
  ACCESS_TOKEN_REQUIRED: "ACCESS_TOKEN_REQUIRED",
} as const;

export type CompletionErrorCode =
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

export const SLICE8_LEDGER_DEBIT_TYPE = "WEEKLY_PAYOUT" as const;

export const SLICE8_PROOF_DRIVERS = {
  AHMED_ID: "5ed232c3-8bb5-4085-95d6-73e48e6c5e28",
  AHMED_AMOUNT_PENCE: 1001,
  BOSTEYO_ID: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
  BOSTEYO_DEST: "e9e43f5c-20fe-479e-8cfe-edb7fb3e0784",
  BOSTEYO_AMOUNT_PENCE: 408,
  BOSTEYO_ITEM_HINT: "4628cba3-b983-4406-b81c-78fb3bb92b54",
  FLEET_LIVE_BEFORE_PENCE: 1409,
  FLEET_RESERVED_BEFORE_PENCE: 1409,
  FLEET_LIVE_AFTER_BOSTEYO_PENCE: 1001,
  FLEET_RESERVED_AFTER_BOSTEYO_PENCE: 1001,
  FLEET_AVAILABLE_AFTER_BOSTEYO_PENCE: 0,
  OCCURRENCE_KEY: "weekly-payout:milton-keynes:2026-07-14T12:00:00+01:00",
} as const;

export function normalizeProviderState(
  state: string | null | undefined,
): string {
  return String(state ?? "").trim().toLowerCase();
}

export function isCanonicalProviderCompleted(
  state: string | null | undefined,
): boolean {
  return normalizeProviderState(state) === REVOLUT_TRANSACTION_STATES.COMPLETED;
}

export function mayFinaliseFromProviderState(
  state: string | null | undefined,
): { ok: true } | { ok: false; code: CompletionErrorCode; message: string } {
  const s = normalizeProviderState(state);
  if (s === REVOLUT_TRANSACTION_STATES.COMPLETED) return { ok: true };
  return {
    ok: false,
    code: COMPLETION_ERROR.PROVIDER_NOT_COMPLETED,
    message: `Provider state '${s || "unknown"}' must never consume reservation or debit wallet`,
  };
}

/** Slice 8 admin finalize is allowed whenever TRANSPORT/reconcile path is used; LIVE gates orchestrator only. */
export function evaluateSlice8FlagGate(_env: {
  get(key: string): string | undefined;
}): { ok: true } | { ok: false; code: CompletionErrorCode; message: string } {
  return { ok: true };
}

export function ledgerTypeForCompletionBatchKind(kind: string | null | undefined): string {
  const k = String(kind ?? "").trim().toUpperCase();
  if (k === "EARLY_CASHOUT") return "EARLY_CASHOUT";
  if (k === "MANUAL_ADMIN" || k === "MANUAL") return "MANUAL_PAYOUT";
  return SLICE8_LEDGER_DEBIT_TYPE;
}

export function completionDebitIdempotencyKey(providerPaymentId: string): string {
  return `revolut-payout-completion:${String(providerPaymentId).trim()}`;
}

export function completionLedgerDescription(args: {
  payout_item_id: string;
  provider_payment_id: string;
  reservation_id?: string | null;
}): string {
  const res = args.reservation_id ? ` reservation=${args.reservation_id}` : "";
  return (
    `Revolut payout completion debit item=${args.payout_item_id}` +
    ` payment=${args.provider_payment_id}${res}`
  );
}

export function evaluateCompletionEligibility(args: {
  item_status: string | null | undefined;
  intent_status: string | null | undefined;
  reservation_status: string | null | undefined;
  item_amount_pence: number;
  reservation_amount_pence: number | null | undefined;
  intent_amount_pence: number | null | undefined;
  currency: string | null | undefined;
  intent_currency?: string | null;
  reservation_currency?: string | null;
  driver_id: string;
  reservation_driver_id?: string | null;
  intent_driver_id?: string | null;
  intent_provider_payment_id?: string | null;
  requested_provider_payment_id?: string | null;
  financially_applied?: boolean;
  reservation_consumed?: boolean;
}): { ok: true } | { ok: false; code: CompletionErrorCode; message: string } {
  if (args.financially_applied && args.reservation_consumed) {
    return {
      ok: false,
      code: COMPLETION_ERROR.ALREADY_APPLIED,
      message: "Financial application already applied",
    };
  }
  if (Boolean(args.financially_applied) !== Boolean(args.reservation_consumed)) {
    if (args.financially_applied || args.reservation_consumed) {
      return {
        ok: false,
        code: COMPLETION_ERROR.INVARIANT_PARTIAL_STATE,
        message: "Partial financial application â recoverable via finalize RPC retry",
      };
    }
  }

  const item = String(args.item_status ?? "").toUpperCase();
  const intent = String(args.intent_status ?? "").toUpperCase();
  if (item === "COMPLETED" && intent === "COMPLETED" && args.financially_applied) {
    return {
      ok: false,
      code: COMPLETION_ERROR.ALREADY_APPLIED,
      message: "Payout already completed",
    };
  }
  if (!["SUBMITTED", "UNKNOWN", "COMPLETED"].includes(item)) {
    return {
      ok: false,
      code: COMPLETION_ERROR.PAYOUT_ITEM_NOT_SUBMITTED,
      message: `Item status ${item || "null"} is not eligible for completion`,
    };
  }
  if (!["SUBMITTED", "UNKNOWN", "COMPLETED"].includes(intent)) {
    return {
      ok: false,
      code: COMPLETION_ERROR.PAYOUT_ITEM_NOT_SUBMITTED,
      message: `Intent status ${intent || "null"} is not eligible for completion`,
    };
  }

  const res = String(args.reservation_status ?? "").toUpperCase();
  if (res !== "ACTIVE" && res !== "CONSUMED") {
    return {
      ok: false,
      code: COMPLETION_ERROR.RESERVATION_NOT_ACTIVE,
      message: `Reservation status ${res || "null"} cannot be finalised`,
    };
  }

  const payId = String(args.intent_provider_payment_id ?? "").trim();
  if (!payId) {
    return {
      ok: false,
      code: COMPLETION_ERROR.MISSING_PROVIDER_PAYMENT_ID,
      message: "provider_payment_id required",
    };
  }
  const requested = String(args.requested_provider_payment_id ?? "").trim();
  if (requested && requested !== payId) {
    return {
      ok: false,
      code: COMPLETION_ERROR.PROVIDER_PAYMENT_ID_MISMATCH,
      message: "provider_payment_id mismatch",
    };
  }

  const amount = Math.round(Number(args.item_amount_pence));
  const resAmt = args.reservation_amount_pence == null
    ? amount
    : Math.round(Number(args.reservation_amount_pence));
  const intentAmt = args.intent_amount_pence == null
    ? amount
    : Math.round(Number(args.intent_amount_pence));
  if (amount !== resAmt || amount !== intentAmt) {
    return {
      ok: false,
      code: COMPLETION_ERROR.AMOUNT_MISMATCH,
      message: `Amount mismatch item=${amount} reservation=${resAmt} intent=${intentAmt}`,
    };
  }

  const cur = String(args.currency ?? "GBP").toUpperCase();
  if (cur !== "GBP") {
    return {
      ok: false,
      code: COMPLETION_ERROR.CURRENCY_MISMATCH,
      message: `Currency must be GBP, got ${cur}`,
    };
  }
  for (const c of [args.intent_currency, args.reservation_currency]) {
    if (c && String(c).toUpperCase() !== "GBP") {
      return {
        ok: false,
        code: COMPLETION_ERROR.CURRENCY_MISMATCH,
        message: "Currency mismatch vs GBP",
      };
    }
  }

  if (
    args.reservation_driver_id &&
    String(args.reservation_driver_id) !== String(args.driver_id)
  ) {
    return {
      ok: false,
      code: COMPLETION_ERROR.DRIVER_MISMATCH,
      message: "Reservation driver_id mismatch",
    };
  }
  if (
    args.intent_driver_id &&
    String(args.intent_driver_id) !== String(args.driver_id)
  ) {
    return {
      ok: false,
      code: COMPLETION_ERROR.DRIVER_MISMATCH,
      message: "Intent driver_id mismatch",
    };
  }

  return { ok: true };
}

export function redactCompletionEvidence(args: {
  provider_payment_id?: string | null;
  provider_state?: string | null;
  provider_request_id?: string | null;
  completed_at?: string | null;
  amount_pence?: number | null;
  currency?: string | null;
}): Record<string, unknown> {
  const id = String(args.provider_payment_id ?? "").trim();
  const masked = id
    ? (id.length <= 8 ? `${id.slice(0, 2)}â¦` : `${id.slice(0, 4)}â¦${id.slice(-4)}`)
    : null;
  return {
    provider_payment_id_masked: masked,
    provider_state: args.provider_state ?? null,
    provider_request_id: args.provider_request_id ?? null,
    provider_completed_at: args.completed_at ?? null,
    amount_pence: args.amount_pence ?? null,
    currency: args.currency ?? null,
    source: "Revolut payout completion",
    sensitive_payload_stored: false,
  };
}

export function assertSlice8MoneySafety(args: {
  provider_state?: string | null;
  wallet_debited?: boolean;
  reservation_consumed?: boolean;
  live_payout_execution_enabled?: boolean;
  revolut_pay_called?: boolean;
  forged_completion?: boolean;
}): void {
  // LIVE may be true for weekly orchestrator; Slice 8 must not create another /pay.
  if (args.revolut_pay_called) {
    throw new Error("SLICE8_INVARIANT: must not create another Revolut /pay");
  }
  if (args.forged_completion) {
    throw new Error("SLICE8_INVARIANT: must not forge provider completed");
  }
  if (args.wallet_debited || args.reservation_consumed) {
    if (!isCanonicalProviderCompleted(args.provider_state)) {
      throw new Error(
        "SLICE8_INVARIANT: debit/consume without canonical Revolut completed",
      );
    }
  }
  if (Boolean(args.wallet_debited) !== Boolean(args.reservation_consumed)) {
    throw new Error("SLICE8_INVARIANT: debit and consume must be applied together");
  }
}
