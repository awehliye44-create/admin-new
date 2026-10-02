/**
 * Canonical driver payout eligibility SSOT (pure — no I/O).
 */
import { FINANCIAL_MODEL, resolveFinancialModelStamp } from "./financialModelScopeSSOT.ts";
import { resolveStablePayoutClearingOriginMs } from "./paymentSessionCaptureTimestampSSOT.ts";
import {
  resolveTerminalEntitledDriverId,
  resolveTerminalOutcomeKind,
  type TerminalOutcomeKind,
} from "./terminalOutcomeKindSSOT.ts";

export const PAYOUT_ELIGIBILITY_STATUS = {
  ELIGIBLE: "ELIGIBLE",
  MISSING_EARNING_SETTLEMENT: "MISSING_EARNING_SETTLEMENT",
  CAPTURE_PENDING: "CAPTURE_PENDING",
  CAPTURE_MISMATCH: "CAPTURE_MISMATCH",
  SETTLEMENT_PENDING: "SETTLEMENT_PENDING",
  SETTLEMENT_MISMATCH: "SETTLEMENT_MISMATCH",
  WALLET_CREDIT_MISMATCH: "WALLET_CREDIT_MISMATCH",
  REFUND_HOLD: "REFUND_HOLD",
  CHARGEBACK_HOLD: "CHARGEBACK_HOLD",
  DEBT_RECOVERY: "DEBT_RECOVERY",
  ADMIN_HOLD: "ADMIN_HOLD",
  PAYOUT_ALLOCATED: "PAYOUT_ALLOCATED",
  PAYOUT_PROCESSING: "PAYOUT_PROCESSING",
  ACCOUNT_UNVERIFIED: "ACCOUNT_UNVERIFIED",
  PAYOUT_PROVIDER_UNAVAILABLE: "PAYOUT_PROVIDER_UNAVAILABLE",
  UNKNOWN_ELIGIBILITY_ERROR: "UNKNOWN_ELIGIBILITY_ERROR",
} as const;

export type PayoutEligibilityStatus =
  (typeof PAYOUT_ELIGIBILITY_STATUS)[keyof typeof PAYOUT_ELIGIBILITY_STATUS];

/** Balance-affecting earning credits that can become payout-eligible. */
export const PAYOUT_ELIGIBLE_LEDGER_TYPES = new Set([
  "TRIP_EARNING_NET",
  "DRIVER_COMPENSATION_CREDIT",
  "DRIVER_TIP_CREDIT",
  "TIP_CREDIT",
]);

/** Admin manual wallet credits — immediately available when metadata.payout_eligible. */
export const ADMIN_WALLET_PAYOUT_ELIGIBLE_LEDGER_TYPES = new Set([
  "ADMIN_WALLET_CREDIT",
]);

export const DES_SOURCE_WALLET_CREDIT = "REVOLUT_WALLET_CREDIT";
export const DES_SOURCE_PHASE1_BACKFILL = "REVOLUT_PHASE1_BACKFILL";
export const DES_FORMULA_VERSION = "payout_eligibility_v2";

/** Backend-owned fallback when Revolut does not expose a merchant-clearing event. */
export const DEFAULT_PAYOUT_CLEARING_DELAY_HOURS = 27;

/** Holds that mean captured-but-not-withdrawable (settlement Pending). Not reservations, not voided/uncaptured. */
export const SETTLEMENT_PENDING_HOLD_REASONS = new Set<PayoutEligibilityStatus>([
  PAYOUT_ELIGIBILITY_STATUS.SETTLEMENT_PENDING,
]);

export type PayoutClearingPolicy = {
  now_ms?: number;
  clearing_delay_hours?: number;
};

/**
 * Settlement-pending applies only where ONECAB collects the customer payment.
 * DRIVER_COLLECTED_COMMISSION_WALLET never uses Driver Wallet payout clearing.
 * Those credits must not become Available (evaluateLedgerEntryEligibility zeros them).
 */
export function requiresPlatformCollectedClearing(args: {
  payment_collection_model?: string | null;
  financial_model?: string | null;
  payment_method?: string | null;
}): boolean {
  const model = String(
    args.payment_collection_model ?? args.financial_model ?? "",
  ).trim().toUpperCase();
  if (!model || model.includes("DRIVER_COLLECTED")) return false;
  const method = String(args.payment_method ?? "").trim().toLowerCase();
  if (method === "cash" || method.includes("cash")) return false;
  return true;
}

export type PayoutClearingEvidence = {
  payment_collection_model?: string | null;
  financial_model?: string | null;
  payment_method?: string | null;
  /** Audit evidence only — provider availability never shortens the clearing delay. */
  provider_available_on?: string | null;
  settled_at?: string | null;
  des_settlement_status?: string | null;
  /** Audit evidence only — provider settlement states never shorten the clearing delay. */
  provider_state?: string | null;
  /** Payment Sessions capture confirmation time — delay origin, not SSOT alone. */
  captured_at?: string | null;
  /** Immutable first capture when stored in session metadata. */
  first_captured_at?: string | null;
  /** DES capture companion — economic settlement fallback. */
  capture_time?: string | null;
  /** Trip completion — clearing origin fallback; never alone for Available. */
  trip_completed_at?: string | null;
  /** Ledger credit time — delay origin fallback when captured_at is missing/restamped. */
  earning_credited_at?: string | null;
};

/**
 * Payout-cleared for PLATFORM_COLLECTED card earnings: stable clearing origin +
 * the configured delay (27h), with no exception. Provider availability or
 * settlement state (available_on, SETTLE, AVAILABLE, PAID_OUT, ...) never makes
 * an earning Available sooner, and a pending provider state never delays it.
 * Mirrors SQL driver_wallet_eligibility_balances.
 */
export function isPayoutClearedForPlatformCollected(
  evidence: PayoutClearingEvidence,
  policy?: PayoutClearingPolicy,
): boolean {
  if (!requiresPlatformCollectedClearing(evidence)) return true;
  const nowMs = policy?.now_ms ?? Date.now();
  const delayHours = policy?.clearing_delay_hours;
  const hours = typeof delayHours === "number" && Number.isFinite(delayHours)
    ? Math.max(0, delayHours)
    : DEFAULT_PAYOUT_CLEARING_DELAY_HOURS;

  const origin = resolveStablePayoutClearingOriginMs({
    captured_at: evidence.captured_at,
    trip_completed_at: evidence.trip_completed_at,
    earning_credited_at: evidence.earning_credited_at,
    capture_time: evidence.capture_time,
    first_captured_at: evidence.first_captured_at,
  });
  if (origin == null) return false;
  return origin + hours * 3_600_000 <= nowMs;
}

export type LedgerEligibilityEvidence = {
  ledger_entry_id: string;
  trip_id: string | null;
  ledger_type: string;
  amount_pence: number;
  /** Trip exists and is linked. */
  trip_exists: boolean;
  payment_session_id: string | null;
  /** Confirmed Payment Sessions capture (pence). Null = no confirmed capture. */
  captured_amount_pence: number | null;
  /** Canonical settled driver net from trip (pence). */
  canonical_driver_net_pence: number | null;
  /** Tip amount on trip when evaluating tip credits. */
  canonical_tip_pence?: number | null;
  /** Optional FR trip status; null = not supplied (do not invent pending). */
  fr_trip_status?: string | null;
  refunded_amount_pence?: number | null;
  chargeback_hold?: boolean;
  allocated_to_payout?: boolean;
  allocated_amount_pence?: number | null;
  paid_in_batch_id?: string | null;
  paid_in_payout_item_id?: string | null;
  payout_processing?: boolean;
  /** Companion DES row present (audit only — not required for Revolut eligibility). */
  des_present?: boolean;
  des_eligible_for_payout?: boolean | null;
  payment_collection_model?: string | null;
  financial_model?: string | null;
  payment_method?: string | null;
  provider_available_on?: string | null;
  settled_at?: string | null;
  des_settlement_status?: string | null;
  provider_state?: string | null;
  captured_at?: string | null;
  first_captured_at?: string | null;
  capture_time?: string | null;
  earning_credited_at?: string | null;
  /** Trip workflow status. Pending/Available require completed, never cancelled. */
  trip_status?: string | null;
  trip_cancelled?: boolean | null;
  completed_at?: string | null;
  session_status?: string | null;
  /** Payment Sessions provider fee when evaluating terminal compensation. */
  provider_processing_fee_pence?: number | null;
  fee_status?: string | null;
  /** Admin manual wallet credit — metadata.payout_eligible when ledger_type is ADMIN_WALLET_CREDIT. */
  admin_wallet_payout_eligible?: boolean | null;
  /** driver_wallet_ledger.driver_id of this entry. */
  ledger_driver_id?: string | null;
  trip_financial_outcome?: string | null;
  trip_payment_status?: string | null;
  trip_no_show_charge_pence?: number | null;
  trip_driver_id?: string | null;
  trip_confirmed_driver_id?: string | null;
  trip_previous_driver_id?: string | null;
  /** Same driver has a non-zero PLATFORM_COMMISSION row for this trip. */
  trip_commission_ledger_present?: boolean | null;
  /** Same driver has a LEDGER_REVERSAL / REFUND_DEBIT row for this trip. */
  trip_reversal_ledger_present?: boolean | null;
};

export type EligiblePayoutEntry = {
  ledger_entry_id: string;
  trip_id: string | null;
  amount_pence: number;
  eligibility_status: typeof PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE;
  des_companion_missing: boolean;
};

export type HeldPayoutEntry = {
  ledger_entry_id: string;
  trip_id: string | null;
  amount_pence: number;
  hold_reason: Exclude<PayoutEligibilityStatus, "ELIGIBLE">;
};

export type DriverPayoutEligibilityResult = {
  live_balance_pence: number;
  available_balance_pence: number;
  /** Earned but not yet payout-cleared. Does NOT include withdrawal reservations. */
  pending_balance_pence: number;
  /** ACTIVE payout reservations + in-flight cashouts. Separate from settlement Pending. */
  withdrawal_in_progress_pence: number;
  outstanding_debt_pence: number;
  /** Sum of eligible entry amounts before debt / in-flight caps. */
  eligible_earnings_pence: number;
  eligible_entries: EligiblePayoutEntry[];
  held_entries: HeldPayoutEntry[];
  /** Dominant hold when available is 0 and live > 0. */
  primary_hold_reason: Exclude<PayoutEligibilityStatus, "ELIGIBLE"> | null;
};

export type AggregateDriverPayoutEligibilityInput = {
  live_balance_pence: number;
  outstanding_debt_pence?: number;
  in_flight_cashout_pence?: number;
  /** ACTIVE Slice 6 DRIVER_PAYOUT reservations (hold, not a debit). */
  reserved_payout_pence?: number;
  /**
   * Stage C2: operational pause zeros Available (pending = live pool).
   * Replaces legacy drivers.payouts_enabled as the Available short-circuit.
   */
  payout_operational_paused?: boolean | null;
  /**
   * @deprecated Stage C2 — ignored for Available/Withdrawable gates.
   * Retained for call-site compatibility / diagnostics only. Do not reintroduce
   * as a hard gate; removal tracked separately after executor proof.
   */
  payouts_enabled?: boolean | null;
  payout_provider_available?: boolean | null;
  /**
   * Stage C2: verification does NOT zero Available. Callers must apply
   * ACCOUNT_UNVERIFIED via driverPayoutWithdrawalQuoteSSOT withdrawable gates.
   * When false, primary_hold_reason may still surface ACCOUNT_UNVERIFIED after
   * normal aggregation if nothing else blocks.
   */
  account_verified?: boolean | null;
  clearing_policy?: PayoutClearingPolicy;
  entries: LedgerEligibilityEvidence[];
};

function remainingPayable(amount: number, allocated: number, fullyAllocated: boolean): number {
  if (fullyAllocated) return 0;
  return Math.max(0, Math.max(0, amount) - Math.max(0, allocated));
}

function expectedCanonicalNet(entry: LedgerEligibilityEvidence): number | null {
  const type = String(entry.ledger_type ?? "").toUpperCase();
  if (type === "TRIP_EARNING_NET") {
    return entry.canonical_driver_net_pence == null
      ? null
      : Math.max(0, Math.round(Number(entry.canonical_driver_net_pence)));
  }
  if (type === "DRIVER_COMPENSATION_CREDIT") {
    const captured = entry.captured_amount_pence == null
      ? null
      : Math.round(Number(entry.captured_amount_pence));
    const fee = entry.provider_processing_fee_pence == null
      ? null
      : Math.round(Number(entry.provider_processing_fee_pence));
    const feeConfirmed = String(entry.fee_status ?? "").toUpperCase() === "ACTUAL"
      || (fee != null && fee >= 0 && entry.provider_processing_fee_pence != null);
    if (captured != null && captured > 0 && feeConfirmed && fee != null) {
      return Math.max(0, captured - fee);
    }
    if (!feeConfirmed && captured != null && captured > 0) {
      return null;
    }
    return Math.max(0, Math.round(Number(entry.amount_pence ?? 0))) || null;
  }
  if (type === "DRIVER_TIP_CREDIT" || type === "TIP_CREDIT") {
    if (entry.canonical_tip_pence == null) return null;
    return Math.max(0, Math.round(Number(entry.canonical_tip_pence)));
  }
  return null;
}

/** Derive FR/settlement gate for a trip earning — never invent RECONCILIATION_PENDING. */
export function deriveTripFrStatusForPayoutEligibility(args: {
  canonical_driver_net_pence: number | null | undefined;
  captured_amount_pence: number | null | undefined;
  settlement_formula_version?: string | null;
  completed_at?: string | null;
  trip_payment_status?: string | null;
}): string | null {
  const net = args.canonical_driver_net_pence == null
    ? null
    : Math.max(0, Math.round(Number(args.canonical_driver_net_pence)));
  const captured = args.captured_amount_pence == null
    ? null
    : Math.round(Number(args.captured_amount_pence));
  if (net == null || net <= 0) return null;
  if (captured == null || !Number.isFinite(captured) || captured <= 0) return null;

  const pay = String(args.trip_payment_status ?? "").toLowerCase();
  const capturedStatus = pay === "captured" || pay === "paid" || pay === "succeeded" || pay === "partially_paid";
  // Capture + canonical net prove the earning exists. Do NOT treat trip.completed_at
  // as payout-clearing — that is a liquidity gate, not FR existence.
  const settled = Boolean(args.settlement_formula_version) || capturedStatus;

  return settled ? "BALANCED" : null;
}

export function isCancelledOrUncompletedEarning(entry: {
  trip_status?: string | null;
  trip_cancelled?: boolean | null;
  completed_at?: string | null;
  session_status?: string | null;
  provider_state?: string | null;
}): boolean {
  if (entry.trip_cancelled === true) return true;
  const trip = String(entry.trip_status ?? "").trim().toLowerCase();
  const session = String(entry.session_status ?? "").trim().toLowerCase();
  const state = String(entry.provider_state ?? "").trim().toLowerCase();
  if (trip.includes("cancel")) return true;
  if (
    session.includes("cancel")
    || session.includes("void")
    || session.includes("fail")
    || session === "released"
  ) {
    return true;
  }
  if (["cancelled", "canceled", "failed", "void"].includes(state)) return true;
  if (trip && trip !== "completed" && !entry.completed_at) return true;
  return false;
}

/**
 * Chargeable terminal earning (Arrival Cancellation / No-Show / Late Passenger
 * Cancellation). The trip stays cancelled / no_show by design, so the
 * completed-trip gate and the trips.driver_net_pence stamp do not apply.
 * Mirrors SQL driver_wallet_eligibility_balances.
 */
export function resolveChargeableTerminalEarningKind(
  entry: LedgerEligibilityEvidence,
): TerminalOutcomeKind | null {
  if (String(entry.ledger_type ?? "").toUpperCase() !== "TRIP_EARNING_NET") return null;
  if (!entry.trip_id) return null;
  return resolveTerminalOutcomeKind({
    financial_outcome: entry.trip_financial_outcome,
    status: entry.trip_status,
    payment_status: entry.trip_payment_status,
    no_show_charge_pence: entry.trip_no_show_charge_pence,
  });
}

/** captured − ACTUAL provider fee, commission 0. Null until both are confirmed. */
export function terminalEarningCanonicalPence(entry: {
  captured_amount_pence?: number | null;
  provider_processing_fee_pence?: number | null;
  fee_status?: string | null;
}): number | null {
  const captured = entry.captured_amount_pence == null
    ? null
    : Math.round(Number(entry.captured_amount_pence));
  if (captured == null || !Number.isFinite(captured) || captured <= 0) return null;
  if (String(entry.fee_status ?? "").trim().toUpperCase() !== "ACTUAL") return null;
  if (entry.provider_processing_fee_pence == null) return null;
  const fee = Math.round(Number(entry.provider_processing_fee_pence));
  if (!Number.isFinite(fee) || fee < 0) return null;
  return captured - fee;
}

function terminalSessionVoided(entry: LedgerEligibilityEvidence): boolean {
  const session = String(entry.session_status ?? "").trim().toLowerCase();
  const state = String(entry.provider_state ?? "").trim().toLowerCase();
  if (
    session.includes("cancel")
    || session.includes("void")
    || session.includes("fail")
    || session === "released"
  ) {
    return true;
  }
  return ["cancelled", "canceled", "failed", "void"].includes(state);
}

function evaluateTerminalEarningEligibility(
  entry: LedgerEligibilityEvidence,
  amount: number,
  policy?: PayoutClearingPolicy,
): { status: PayoutEligibilityStatus; payable_pence: number } {
  const allocated = Math.max(0, Math.round(Number(entry.allocated_amount_pence ?? 0)));
  const payable = remainingPayable(amount, allocated, false);
  if (payable <= 0) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.PAYOUT_ALLOCATED, payable_pence: 0 };
  }
  if (entry.payout_processing === true) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.PAYOUT_PROCESSING, payable_pence: payable };
  }

  const owner = resolveTerminalEntitledDriverId({
    driver_id: entry.trip_driver_id,
    confirmed_driver_id: entry.trip_confirmed_driver_id,
    previous_driver_id: entry.trip_previous_driver_id,
  });
  const ledgerOwner = String(entry.ledger_driver_id ?? "").trim();
  if (!owner || !ledgerOwner || ledgerOwner !== owner) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.UNKNOWN_ELIGIBILITY_ERROR, payable_pence: 0 };
  }
  if (entry.trip_commission_ledger_present === true) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.SETTLEMENT_MISMATCH, payable_pence: payable };
  }
  if (entry.trip_reversal_ledger_present === true) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.REFUND_HOLD, payable_pence: payable };
  }
  if (terminalSessionVoided(entry)) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.UNKNOWN_ELIGIBILITY_ERROR, payable_pence: 0 };
  }
  if (entry.chargeback_hold === true) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.CHARGEBACK_HOLD, payable_pence: payable };
  }
  const refunded = Math.max(0, Math.round(Number(entry.refunded_amount_pence ?? 0)));
  if (refunded > 0) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.REFUND_HOLD, payable_pence: payable };
  }
  if (!entry.trip_exists || !entry.payment_session_id) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.CAPTURE_PENDING, payable_pence: payable };
  }
  const captured = entry.captured_amount_pence == null
    ? null
    : Math.round(Number(entry.captured_amount_pence));
  if (captured == null || !Number.isFinite(captured) || captured <= 0) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.CAPTURE_PENDING, payable_pence: payable };
  }
  const canonical = terminalEarningCanonicalPence(entry);
  if (canonical == null || canonical <= 0) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.SETTLEMENT_MISMATCH, payable_pence: payable };
  }
  if (amount !== canonical) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.WALLET_CREDIT_MISMATCH, payable_pence: payable };
  }
  if (!isPayoutClearedForPlatformCollected(entry, policy)) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.SETTLEMENT_PENDING, payable_pence: payable };
  }
  return { status: PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE, payable_pence: payable };
}

/**
 * Evaluate one balance-affecting earning credit.
 * Capture is necessary but not sufficient for PLATFORM_COLLECTED Available.
 * Does not require DES. Does not require Connect settlement fields.
 */
export function evaluateLedgerEntryEligibility(
  entry: LedgerEligibilityEvidence,
  policy?: PayoutClearingPolicy,
): { status: PayoutEligibilityStatus; payable_pence: number } {
  const amount = Math.max(0, Math.round(Number(entry.amount_pence ?? 0)));
  const type = String(entry.ledger_type ?? "").toUpperCase();

  if (ADMIN_WALLET_PAYOUT_ELIGIBLE_LEDGER_TYPES.has(type)) {
    if (amount <= 0) {
      return { status: PAYOUT_ELIGIBILITY_STATUS.UNKNOWN_ELIGIBILITY_ERROR, payable_pence: 0 };
    }
    if (entry.admin_wallet_payout_eligible === false) {
      return { status: PAYOUT_ELIGIBILITY_STATUS.ADMIN_HOLD, payable_pence: amount };
    }
    if (entry.allocated_to_payout === true || entry.paid_in_batch_id || entry.paid_in_payout_item_id) {
      return { status: PAYOUT_ELIGIBILITY_STATUS.PAYOUT_ALLOCATED, payable_pence: 0 };
    }
    const allocated = Math.max(0, Math.round(Number(entry.allocated_amount_pence ?? 0)));
    const payable = remainingPayable(amount, allocated, false);
    if (payable <= 0) {
      return { status: PAYOUT_ELIGIBILITY_STATUS.PAYOUT_ALLOCATED, payable_pence: 0 };
    }
    if (entry.payout_processing === true) {
      return { status: PAYOUT_ELIGIBILITY_STATUS.PAYOUT_PROCESSING, payable_pence: payable };
    }
    return { status: PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE, payable_pence: payable };
  }

  if (!PAYOUT_ELIGIBLE_LEDGER_TYPES.has(type) || amount <= 0) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.UNKNOWN_ELIGIBILITY_ERROR, payable_pence: 0 };
  }

  const financialModel = resolveFinancialModelStamp(
    entry.financial_model ?? entry.payment_collection_model,
  );
  if (financialModel === FINANCIAL_MODEL.UNKNOWN) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.UNKNOWN_ELIGIBILITY_ERROR, payable_pence: 0 };
  }
  if (financialModel === FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.UNKNOWN_ELIGIBILITY_ERROR, payable_pence: 0 };
  }
  if (entry.trip_id) {
    if (financialModel !== FINANCIAL_MODEL.PLATFORM_COLLECTED) {
      return { status: PAYOUT_ELIGIBILITY_STATUS.UNKNOWN_ELIGIBILITY_ERROR, payable_pence: 0 };
    }
  }

  if (entry.paid_in_batch_id || entry.allocated_to_payout === true || entry.paid_in_payout_item_id) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.PAYOUT_ALLOCATED, payable_pence: 0 };
  }

  if (resolveChargeableTerminalEarningKind(entry)) {
    return evaluateTerminalEarningEligibility(entry, amount, policy);
  }

  if (isCancelledOrUncompletedEarning(entry)) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.UNKNOWN_ELIGIBILITY_ERROR, payable_pence: 0 };
  }

  const allocated = Math.max(0, Math.round(Number(entry.allocated_amount_pence ?? 0)));
  const payable = remainingPayable(amount, allocated, false);
  if (payable <= 0) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.PAYOUT_ALLOCATED, payable_pence: 0 };
  }

  if (entry.payout_processing === true) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.PAYOUT_PROCESSING, payable_pence: payable };
  }

  if (entry.chargeback_hold === true) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.CHARGEBACK_HOLD, payable_pence: payable };
  }

  const refunded = Math.max(0, Math.round(Number(entry.refunded_amount_pence ?? 0)));
  if (refunded > 0) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.REFUND_HOLD, payable_pence: payable };
  }

  if (!entry.trip_exists || !entry.trip_id) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.UNKNOWN_ELIGIBILITY_ERROR, payable_pence: payable };
  }

  const captured = entry.captured_amount_pence == null
    ? null
    : Math.round(Number(entry.captured_amount_pence));

  if (!entry.payment_session_id || captured == null) {
    // Missing capture is CAPTURE_PENDING — never conflate with missing DES.
    // DES is optional; missing companion must not erase valid wallet credits once capture+settlement exist.
    return { status: PAYOUT_ELIGIBILITY_STATUS.CAPTURE_PENDING, payable_pence: payable };
  }

  if (!Number.isFinite(captured) || captured <= 0) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.CAPTURE_PENDING, payable_pence: payable };
  }

  const canonical = expectedCanonicalNet(entry);
  if (canonical == null || canonical <= 0) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.SETTLEMENT_MISMATCH, payable_pence: payable };
  }

  if (amount !== canonical) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.WALLET_CREDIT_MISMATCH, payable_pence: payable };
  }

  const fr = String(entry.fr_trip_status ?? "").trim().toUpperCase();
  if (fr && fr !== "BALANCED" && fr !== "OK" && fr !== "CLEARED") {
    return { status: PAYOUT_ELIGIBILITY_STATUS.SETTLEMENT_MISMATCH, payable_pence: payable };
  }

  // Capture must be confirmed and positive; mismatch vs fare is informational —
  // driver_net match is the wallet SSOT gate. Extreme under-capture vs net is held.
  if (captured < canonical) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.CAPTURE_MISMATCH, payable_pence: payable };
  }

  if (!isPayoutClearedForPlatformCollected(entry, policy)) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.SETTLEMENT_PENDING, payable_pence: payable };
  }

  return { status: PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE, payable_pence: payable };
}

function settlementPendingPence(held: HeldPayoutEntry[]): number {
  let sum = 0;
  for (const row of held) {
    if (SETTLEMENT_PENDING_HOLD_REASONS.has(row.hold_reason as PayoutEligibilityStatus)) {
      sum += Math.max(0, Math.round(Number(row.amount_pence ?? 0)));
    }
  }
  return sum;
}

/**
 * Aggregate per-driver payout eligibility from evaluated ledger evidence.
 *
 * Unpaid invariant (debt/reservations aside):
 *   Pending + Available = Live unpaid balance
 *
 * available = min(eligible_sum, live − pending) − debt − withdrawal_in_progress (floored at 0).
 * pending = captured SETTLEMENT_PENDING only (not reservations, not cancelled/uncaptured).
 *
 * eligible_sum may still list historically cleared rows that were already paid out
 * (DES allocation missing). Cap Available (and reported eligible_earnings) by
 * live − pending so already-paid pools cannot inflate Available above unpaid live.
 */
export function aggregateDriverPayoutEligibility(
  input: AggregateDriverPayoutEligibilityInput,
): DriverPayoutEligibilityResult {
  const live = Math.round(Number(input.live_balance_pence ?? 0));
  const debt = Math.max(0, Math.round(Number(input.outstanding_debt_pence ?? 0)));
  const inFlight = Math.max(0, Math.round(Number(input.in_flight_cashout_pence ?? 0)));
  const reserved = Math.max(0, Math.round(Number(input.reserved_payout_pence ?? 0)));
  const withdrawalInProgress = reserved + inFlight;
  const policy = input.clearing_policy;

  const eligible_entries: EligiblePayoutEntry[] = [];
  const held_entries: HeldPayoutEntry[] = [];

  // Stage C2: ignore deprecated drivers.payouts_enabled — never short-circuit Available.
  void input.payouts_enabled;

  // Operational pause zeros Available and parks live as Pending (Stage C matrix).
  if (input.payout_operational_paused === true) {
    for (const entry of input.entries) {
      const amount = Math.max(0, Math.round(Number(entry.amount_pence ?? 0)));
      if (amount <= 0 || !PAYOUT_ELIGIBLE_LEDGER_TYPES.has(String(entry.ledger_type ?? "").toUpperCase())) {
        continue;
      }
      held_entries.push({
        ledger_entry_id: entry.ledger_entry_id,
        trip_id: entry.trip_id,
        amount_pence: amount,
        hold_reason: PAYOUT_ELIGIBILITY_STATUS.ADMIN_HOLD,
      });
    }
    return {
      live_balance_pence: live,
      available_balance_pence: 0,
      pending_balance_pence: Math.max(0, live),
      withdrawal_in_progress_pence: withdrawalInProgress,
      outstanding_debt_pence: debt,
      eligible_earnings_pence: 0,
      eligible_entries,
      held_entries,
      primary_hold_reason: PAYOUT_ELIGIBILITY_STATUS.ADMIN_HOLD,
    };
  }

  // Provider / account verification do NOT zero Available (Stage C).
  // Withdrawable is gated in driverPayoutWithdrawalQuoteSSOT.

  let eligibleSum = 0;
  for (const entry of input.entries) {
    const { status, payable_pence } = evaluateLedgerEntryEligibility(entry, policy);
    if (status === PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE) {
      eligibleSum += payable_pence;
      eligible_entries.push({
        ledger_entry_id: entry.ledger_entry_id,
        trip_id: entry.trip_id,
        amount_pence: payable_pence,
        eligibility_status: PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE,
        des_companion_missing: entry.des_present !== true,
      });
    } else if (payable_pence > 0 || PAYOUT_ELIGIBLE_LEDGER_TYPES.has(String(entry.ledger_type ?? "").toUpperCase())
      || ADMIN_WALLET_PAYOUT_ELIGIBLE_LEDGER_TYPES.has(String(entry.ledger_type ?? "").toUpperCase())) {
      held_entries.push({
        ledger_entry_id: entry.ledger_entry_id,
        trip_id: entry.trip_id,
        amount_pence: Math.max(payable_pence, Math.max(0, Math.round(Number(entry.amount_pence ?? 0)))),
        hold_reason: status as HeldPayoutEntry["hold_reason"],
      });
    }
  }

  const pending = settlementPendingPence(held_entries);
  // Cap cleared pool by unpaid live after settlement-pending — already-paid history
  // still present in eligibleSum must not make Available copy Live.
  const unpaidLiveAfterPending = Math.max(0, Math.max(0, live) - pending);
  const unpaidEligible = Math.min(Math.max(0, eligibleSum), unpaidLiveAfterPending);
  let available = Math.max(0, unpaidEligible - debt - withdrawalInProgress);

  // Debt recovery can wipe available even when entries are otherwise eligible.
  let primary: DriverPayoutEligibilityResult["primary_hold_reason"] = null;
  if (available <= 0 && live > 0) {
    if (debt > 0 && unpaidEligible > 0 && unpaidEligible - debt <= 0) {
      primary = PAYOUT_ELIGIBILITY_STATUS.DEBT_RECOVERY;
      available = 0;
    } else if (held_entries.length > 0) {
      primary = held_entries[0]!.hold_reason;
    } else if (eligibleSum <= 0) {
      primary = PAYOUT_ELIGIBILITY_STATUS.UNKNOWN_ELIGIBILITY_ERROR;
    }
  }

  // Verification hold is informational for withdrawable — Available stays cleared.
  if (
    available > 0
    && input.account_verified === false
    && primary == null
  ) {
    primary = PAYOUT_ELIGIBILITY_STATUS.ACCOUNT_UNVERIFIED;
  }
  if (
    available > 0
    && input.payout_provider_available === false
    && (primary == null || primary === PAYOUT_ELIGIBILITY_STATUS.ACCOUNT_UNVERIFIED)
  ) {
    primary = PAYOUT_ELIGIBILITY_STATUS.PAYOUT_PROVIDER_UNAVAILABLE;
  }

  return {
    live_balance_pence: live,
    available_balance_pence: available,
    pending_balance_pence: pending,
    withdrawal_in_progress_pence: withdrawalInProgress,
    outstanding_debt_pence: debt,
    eligible_earnings_pence: unpaidEligible,
    eligible_entries,
    held_entries,
    primary_hold_reason: primary,
  };
}

/** Zero-batch guard — never create payout artefacts when nothing is payable. */
export function shouldBlockZeroValuePayoutBatch(args: {
  eligible_driver_count: number;
  total_available_pence: number;
}): { block: boolean; error_code: "NO_ELIGIBLE_PAYOUTS" | null } {
  const drivers = Math.max(0, Math.round(Number(args.eligible_driver_count ?? 0)));
  const total = Math.max(0, Math.round(Number(args.total_available_pence ?? 0)));
  if (drivers <= 0 || total <= 0) {
    return { block: true, error_code: "NO_ELIGIBLE_PAYOUTS" };
  }
  return { block: false, error_code: null };
}

export const ZERO_BATCH_FAILURE_CODES = {
  INVALID_ZERO_VALUE_BATCH: "INVALID_ZERO_VALUE_BATCH",
  BLOCKED_NO_ELIGIBLE_PAYOUTS: "BLOCKED_NO_ELIGIBLE_PAYOUTS",
} as const;

/** Idempotency key for DES companion / backfill rows. */
export function desCompanionIdempotencyKey(ledgerEntryId: string, source: string): string {
  return `des:${source}:${ledgerEntryId}`;
}
