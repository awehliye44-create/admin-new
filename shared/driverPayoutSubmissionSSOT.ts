/**
 * Slice 7 — controlled Revolut Business provider submission for RESERVED payout items.
 * Transport may call validated /pay; LIVE_PAYOUT_EXECUTION_ENABLED stays false
 * (no automatic Tuesday scheduler execution). Wallet reservation stays ACTIVE until Slice 8.
 */

export const SLICE7 = 7 as const;

export const SUBMISSION_ERROR = {
  PAYMENT_TRANSPORT_DISABLED: "PAYMENT_TRANSPORT_DISABLED",
  LIVE_AUTOMATIC_EXECUTION_FORBIDDEN: "LIVE_AUTOMATIC_EXECUTION_FORBIDDEN",
  MISSING_SOURCE_ACCOUNT: "MISSING_SOURCE_ACCOUNT",
  SOURCE_ACCOUNT_NOT_GBP: "SOURCE_ACCOUNT_NOT_GBP",
  SOURCE_ACCOUNT_INACTIVE: "SOURCE_ACCOUNT_INACTIVE",
  INSUFFICIENT_SOURCE_BALANCE: "INSUFFICIENT_SOURCE_BALANCE",
  SOURCE_BALANCE_UNAVAILABLE: "SOURCE_BALANCE_UNAVAILABLE",
  PAYOUT_ITEM_NOT_RESERVED: "PAYOUT_ITEM_NOT_RESERVED",
  RESERVATION_NOT_ACTIVE: "RESERVATION_NOT_ACTIVE",
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
  DESTINATION_NOT_ACTIVE: "DESTINATION_NOT_ACTIVE",
  PROVIDER_LINK_NOT_VERIFIED: "PROVIDER_LINK_NOT_VERIFIED",
  ALREADY_SUBMITTED: "ALREADY_SUBMITTED",
  CLAIM_CONFLICT: "CLAIM_CONFLICT",
  SUBMISSION_IN_FLIGHT: "SUBMISSION_IN_FLIGHT",
  UNKNOWN_NO_BLIND_RETRY: "UNKNOWN_NO_BLIND_RETRY",
  COMPANY_TRANSFER_BLOCKED: "COMPANY_TRANSFER_BLOCKED",
  ARBITRARY_PAYMENT_BLOCKED: "ARBITRARY_PAYMENT_BLOCKED",
  ACCESS_TOKEN_REQUIRED: "ACCESS_TOKEN_REQUIRED",
  RELAY_UNREACHABLE: "RELAY_UNREACHABLE",
  PROVIDER_HARD_REJECT: "PROVIDER_HARD_REJECT",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  BATCH_NOT_ELIGIBLE: "BATCH_NOT_ELIGIBLE",
} as const;

export type SubmissionErrorCode =
  (typeof SUBMISSION_ERROR)[keyof typeof SUBMISSION_ERROR];

export const SLICE7_ITEM_STATUS = {
  RESERVED: "RESERVED",
  SUBMITTING: "SUBMITTING",
  SUBMITTED: "SUBMITTED",
  FAILED: "FAILED",
  DECLINED: "DECLINED",
  UNKNOWN: "UNKNOWN",
} as const;

export const SLICE7_BATCH_STATUS = {
  FUNDS_RESERVED_EXECUTION_DISABLED: "FUNDS_RESERVED_EXECUTION_DISABLED",
  PROVIDER_SUBMISSION_PARTIAL: "PROVIDER_SUBMISSION_PARTIAL",
  PROVIDER_SUBMISSION_IN_PROGRESS: "PROVIDER_SUBMISSION_IN_PROGRESS",
} as const;

export const SLICE7_INTENT_STATUS = {
  READY: "READY",
  SUBMITTING: "SUBMITTING",
  SUBMITTED: "SUBMITTED",
  FAILED: "FAILED",
  DECLINED: "DECLINED",
  UNKNOWN: "UNKNOWN",
} as const;

/** Admin labels — never "Paid" for Slice 7 submission success. */
export const ADMIN_SLICE7_LABELS = {
  RESERVED: "Reserved",
  PROVIDER_SUBMITTED: "Submitted to provider",
  PROVIDER_PENDING: "Provider pending",
  PROVIDER_UNKNOWN: "Provider state unknown",
  PROVIDER_FAILED: "Provider submission failed",
  PROVIDER_DECLINED: "Provider declined",
  PAID: "Paid",
  WALLET_DEBIT_NOT_APPLIED: "Wallet debit not applied",
  NOT_PAID: "Not paid",
} as const;

export const SLICE7_PROOF_DRIVERS = {
  AHMED_ID: "5ed232c3-8bb5-4085-95d6-73e48e6c5e28",
  AHMED_AMOUNT_PENCE: 1001,
  BOSTEYO_ID: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
  BOSTEYO_DEST: "e9e43f5c-20fe-479e-8cfe-edb7fb3e0784",
  BOSTEYO_AMOUNT_PENCE: 408,
  FLEET_LIVE_PENCE: 1409,
  FLEET_RESERVED_PENCE: 1409,
  FLEET_AVAILABLE_PENCE: 0,
  OCCURRENCE_KEY: "weekly-payout:milton-keynes:2026-07-14T12:00:00+01:00",
  BATCH_ID_HINT: "94baa4ed-2de7-41cb-a3bd-a648c20d5036",
} as const;

/** Slice 7 may call validated transport when TRANSPORT=true and LIVE=false. */
export function maySubmitReservedDriverPayoutViaTransport(
  env: { get(key: string): string | undefined } = typeof Deno !== "undefined"
    ? Deno.env
    : { get: () => undefined },
): boolean {
  const live = (env.get("LIVE_PAYOUT_EXECUTION_ENABLED") ?? "false").trim().toLowerCase() === "true";
  const transport =
    (env.get("REVOLUT_PAYMENT_TRANSPORT_ENABLED") ?? "false").trim().toLowerCase() === "true";
  return transport && !live;
}

/**
 * Admin Slice 7 submit gate — LIVE must stay false (no automatic weekly execution).
 * Do NOT use this inside Driver Withdraw.
 */
export function evaluateSlice7FlagGate(env: {
  get(key: string): string | undefined;
}): { ok: true } | { ok: false; code: SubmissionErrorCode; message: string } {
  const live = (env.get("LIVE_PAYOUT_EXECUTION_ENABLED") ?? "false").trim().toLowerCase() === "true";
  const transport =
    (env.get("REVOLUT_PAYMENT_TRANSPORT_ENABLED") ?? "false").trim().toLowerCase() === "true";
  if (live) {
    return {
      ok: false,
      code: SUBMISSION_ERROR.LIVE_AUTOMATIC_EXECUTION_FORBIDDEN,
      message: "LIVE_PAYOUT_EXECUTION_ENABLED must stay false for Slice 7 admin submission",
    };
  }
  if (!transport) {
    return {
      ok: false,
      code: SUBMISSION_ERROR.PAYMENT_TRANSPORT_DISABLED,
      message: "REVOLUT_PAYMENT_TRANSPORT_ENABLED must be true for Slice 7 submission",
    };
  }
  return { ok: true };
}

/**
 * Driver Withdraw execution gate — product-triggered Revolut payout.
 * Requires payment transport only. Does NOT inherit the admin Slice 7
 * "LIVE must stay false" invariant (that gates admin weekly/manual submit).
 */
export function evaluateDriverWithdrawExecutionGate(env: {
  get(key: string): string | undefined;
}): { ok: true } | { ok: false; code: SubmissionErrorCode; message: string } {
  const transport =
    (env.get("REVOLUT_PAYMENT_TRANSPORT_ENABLED") ?? "false").trim().toLowerCase() === "true";
  if (!transport) {
    return {
      ok: false,
      code: SUBMISSION_ERROR.PAYMENT_TRANSPORT_DISABLED,
      message: "Withdrawals are temporarily unavailable. Please try again later.",
    };
  }
  return { ok: true };
}

export function rejectCompanyOrArbitraryPayment(body: Record<string, unknown>):
  | { ok: true }
  | { ok: false; code: SubmissionErrorCode; message: string } {
  if (body.company_transfer === true || body.company_payee_id || body.transfer_type === "company") {
    return {
      ok: false,
      code: SUBMISSION_ERROR.COMPANY_TRANSFER_BLOCKED,
      message: "Company transfers are blocked on Slice 7 driver payout submission",
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

export function evaluateSourceAccountGate(args: {
  source_account_id: string | null | undefined;
  currency: string | null | undefined;
  available_pence: number | null | undefined;
  amount_pence: number;
  account_active?: boolean | null;
}): { ok: true; source_account_id: string } | { ok: false; code: SubmissionErrorCode; message: string } {
  const sourceId = String(args.source_account_id ?? "").trim();
  if (!sourceId) {
    return {
      ok: false,
      code: SUBMISSION_ERROR.MISSING_SOURCE_ACCOUNT,
      message: "Company Balance SSOT source account not configured",
    };
  }
  if (args.account_active === false) {
    return {
      ok: false,
      code: SUBMISSION_ERROR.SOURCE_ACCOUNT_INACTIVE,
      message: "Selected Revolut source account is inactive",
    };
  }
  const currency = String(args.currency ?? "").trim().toUpperCase();
  if (currency && currency !== "GBP") {
    return {
      ok: false,
      code: SUBMISSION_ERROR.SOURCE_ACCOUNT_NOT_GBP,
      message: "Source account must be GBP",
    };
  }
  if (args.available_pence == null || !Number.isFinite(Number(args.available_pence))) {
    return {
      ok: false,
      code: SUBMISSION_ERROR.SOURCE_BALANCE_UNAVAILABLE,
      message: "Source account available balance unavailable",
    };
  }
  const available = Math.round(Number(args.available_pence));
  const amount = Math.round(Number(args.amount_pence));
  if (available < amount) {
    return {
      ok: false,
      code: SUBMISSION_ERROR.INSUFFICIENT_SOURCE_BALANCE,
      message: `Source available ${available}p < payout ${amount}p`,
    };
  }
  return { ok: true, source_account_id: sourceId };
}

export function evaluateSubmissionEligibility(args: {
  item_status: string | null | undefined;
  reservation_status: string | null | undefined;
  reservation_amount_pence: number | null | undefined;
  item_amount_pence: number;
  destination_active?: boolean | null;
  provider_link_verified?: boolean | null;
  existing_intent_status?: string | null;
}): { ok: true } | { ok: false; code: SubmissionErrorCode; message: string } {
  const itemStatus = String(args.item_status ?? "").toUpperCase();
  if (itemStatus === "SUBMITTED") {
    return { ok: false, code: SUBMISSION_ERROR.ALREADY_SUBMITTED, message: "Item already submitted" };
  }
  if (itemStatus === "SUBMITTING") {
    return {
      ok: false,
      code: SUBMISSION_ERROR.SUBMISSION_IN_FLIGHT,
      message: "Item submission already in flight",
    };
  }
  if (itemStatus !== "RESERVED") {
    return {
      ok: false,
      code: SUBMISSION_ERROR.PAYOUT_ITEM_NOT_RESERVED,
      message: `Item status ${itemStatus || "null"} is not RESERVED`,
    };
  }
  const reservationStatus = String(args.reservation_status ?? "").toUpperCase();
  if (reservationStatus !== "ACTIVE") {
    return {
      ok: false,
      code: SUBMISSION_ERROR.RESERVATION_NOT_ACTIVE,
      message: "ACTIVE reservation required",
    };
  }
  const reserved = Math.round(Number(args.reservation_amount_pence ?? 0));
  const amount = Math.round(Number(args.item_amount_pence ?? 0));
  if (reserved !== amount || amount <= 0) {
    return {
      ok: false,
      code: SUBMISSION_ERROR.AMOUNT_MISMATCH,
      message: "Reservation amount must match payout item amount",
    };
  }
  if (args.destination_active === false) {
    return {
      ok: false,
      code: SUBMISSION_ERROR.DESTINATION_NOT_ACTIVE,
      message: "Payout destination inactive",
    };
  }
  if (args.provider_link_verified === false) {
    return {
      ok: false,
      code: SUBMISSION_ERROR.PROVIDER_LINK_NOT_VERIFIED,
      message: "Destination provider linkage not verified",
    };
  }
  const intent = String(args.existing_intent_status ?? "").toUpperCase();
  if (intent === "SUBMITTED" || intent === "COMPLETED") {
    return { ok: false, code: SUBMISSION_ERROR.ALREADY_SUBMITTED, message: "Payment intent already submitted" };
  }
  if (intent === "SUBMITTING") {
    return {
      ok: false,
      code: SUBMISSION_ERROR.SUBMISSION_IN_FLIGHT,
      message: "Payment intent submission in flight",
    };
  }
  if (intent === "UNKNOWN") {
    return {
      ok: false,
      code: SUBMISSION_ERROR.UNKNOWN_NO_BLIND_RETRY,
      message: "Prior submission UNKNOWN — no blind retry",
    };
  }
  return { ok: true };
}

/**
 * Map Revolut provider state (+ HTTP outcome) to Slice 7 intent/item execution outcome.
 * PENDING and SUBMITTED (provider pending) are success for Slice 7 — reservation stays ACTIVE.
 */
export function mapProviderSubmissionOutcome(args: {
  http_ok: boolean;
  timed_out?: boolean;
  provider_payment_id?: string | null;
  provider_state?: string | null;
  hard_reject?: boolean;
}): {
  execution_status: "SUBMITTED" | "FAILED" | "DECLINED" | "UNKNOWN";
  item_status: "SUBMITTED" | "FAILED" | "DECLINED" | "UNKNOWN";
  keep_reservation_active: boolean;
  release_reservation: boolean;
  wallet_debited: false;
  paid: false;
} {
  if (args.timed_out) {
    return {
      execution_status: "UNKNOWN",
      item_status: "UNKNOWN",
      keep_reservation_active: true,
      release_reservation: false,
      wallet_debited: false,
      paid: false,
    };
  }
  const state = String(args.provider_state ?? "").trim().toLowerCase();
  if (args.hard_reject || state === "declined") {
    return {
      execution_status: state === "declined" ? "DECLINED" : "FAILED",
      item_status: state === "declined" ? "DECLINED" : "FAILED",
      keep_reservation_active: false,
      release_reservation: true,
      wallet_debited: false,
      paid: false,
    };
  }
  if (state === "failed" || state === "reverted") {
    return {
      execution_status: "FAILED",
      item_status: "FAILED",
      keep_reservation_active: false,
      release_reservation: true,
      wallet_debited: false,
      paid: false,
    };
  }
  // pending / completed / missing-but-id → submitted success for Slice 7 (debit is Slice 8)
  if (
    args.http_ok
    && (Boolean(args.provider_payment_id) || state === "pending" || state === "completed")
  ) {
    return {
      execution_status: "SUBMITTED",
      item_status: "SUBMITTED",
      keep_reservation_active: true,
      release_reservation: false,
      wallet_debited: false,
      paid: false,
    };
  }
  if (!args.http_ok) {
    return {
      execution_status: "FAILED",
      item_status: "FAILED",
      keep_reservation_active: false,
      release_reservation: true,
      wallet_debited: false,
      paid: false,
    };
  }
  return {
    execution_status: "UNKNOWN",
    item_status: "UNKNOWN",
    keep_reservation_active: true,
    release_reservation: false,
    wallet_debited: false,
    paid: false,
  };
}

/**
 * Revolut Business POST /pay `request_id` max length (provider API constraint).
 * Legacy `revolut-driver-payout:{uuid}` was 58 chars and is rejected.
 */
export const REVOLUT_PAY_REQUEST_ID_MAX_LEN = 40;

/**
 * Deterministic Revolut `request_id` / `provider_request_id` per payout_item_id.
 *
 * Format: `oc-dp:` + lowercase UUID hex without dashes
 *   - prefix `oc-dp:` = 6 chars
 *   - uuid hex      = 32 chars
 *   - total          = 38 ≤ 40
 *
 * Stable across retries (idempotent), unique per payout item, and valid for
 * relay + Revolut /pay. Internal `idempotency_key` uses the same value.
 */
export function canonicalProviderRequestId(payoutItemId: string): string {
  const hex = String(payoutItemId ?? "").trim().toLowerCase().replace(/-/g, "");
  const id = `oc-dp:${hex}`;
  if (id.length > REVOLUT_PAY_REQUEST_ID_MAX_LEN) {
    throw new Error(
      `provider_request_id length ${id.length} exceeds Revolut max ${REVOLUT_PAY_REQUEST_ID_MAX_LEN}`,
    );
  }
  return id;
}

export function canonicalIdempotencyKey(payoutItemId: string): string {
  return canonicalProviderRequestId(payoutItemId);
}

export function maskProviderId(id: string | null | undefined): string | null {
  const raw = String(id ?? "").trim();
  if (!raw) return null;
  if (raw.length <= 8) return `${raw.slice(0, 2)}…`;
  return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
}

export function redactProviderEvidence(args: {
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

export function adminItemSubmissionDisplay(args: {
  item_status: string;
  provider_state?: string | null;
  provider_payment_id?: string | null;
  reservation_active?: boolean;
}): {
  reserved_label: string;
  provider_submission_status: string;
  provider_state: string | null;
  provider_payment_id_masked: string | null;
  paid_label: string;
  wallet_debit_label: string;
} {
  const status = String(args.item_status ?? "").toUpperCase();
  const reserved = args.reservation_active !== false
    && !["FAILED", "DECLINED", "RELEASED", "CANCELLED"].includes(status);
  let providerStatus = ADMIN_SLICE7_LABELS.RESERVED;
  if (status === "SUBMITTED") {
    providerStatus = String(args.provider_state ?? "").toLowerCase() === "pending"
      ? ADMIN_SLICE7_LABELS.PROVIDER_PENDING
      : ADMIN_SLICE7_LABELS.PROVIDER_SUBMITTED;
  } else if (status === "SUBMITTING") {
    providerStatus = "Submitting to provider";
  } else if (status === "UNKNOWN") {
    providerStatus = ADMIN_SLICE7_LABELS.PROVIDER_UNKNOWN;
  } else if (status === "FAILED") {
    providerStatus = ADMIN_SLICE7_LABELS.PROVIDER_FAILED;
  } else if (status === "DECLINED") {
    providerStatus = ADMIN_SLICE7_LABELS.PROVIDER_DECLINED;
  }
  return {
    reserved_label: reserved ? ADMIN_SLICE7_LABELS.RESERVED : "Not reserved",
    provider_submission_status: providerStatus,
    provider_state: args.provider_state ?? null,
    provider_payment_id_masked: maskProviderId(args.provider_payment_id),
    paid_label: ADMIN_SLICE7_LABELS.NOT_PAID,
    wallet_debit_label: ADMIN_SLICE7_LABELS.WALLET_DEBIT_NOT_APPLIED,
  };
}

export function assertSlice7MoneySafety(args: {
  wallet_debited?: boolean;
  reservation_consumed?: boolean;
  paid_marked?: boolean;
  live_payout_execution_enabled?: boolean;
  slices_8_to_12_started?: boolean;
}): void {
  if (args.wallet_debited) throw new Error("SLICE7_INVARIANT: wallet permanently debited");
  if (args.reservation_consumed) throw new Error("SLICE7_INVARIANT: reservation consumed");
  if (args.paid_marked) throw new Error("SLICE7_INVARIANT: marked paid");
  if (args.live_payout_execution_enabled) {
    throw new Error("SLICE7_INVARIANT: LIVE_PAYOUT_EXECUTION_ENABLED must be false");
  }
  if (args.slices_8_to_12_started) throw new Error("SLICE7_INVARIANT: slices 8–12 started");
}
