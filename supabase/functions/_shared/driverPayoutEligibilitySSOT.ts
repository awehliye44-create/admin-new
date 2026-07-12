/**
 * Canonical driver payout eligibility SSOT (pure — no I/O).
 *
 * DWL owns monetary balance. Eligibility is proven from:
 *   driver_wallet_ledger → trip → payment_sessions capture → canonical driver_net
 * DES is an optional settlement companion; missing DES must not erase valid wallet credits.
 *
 * Stripe Connect settlement fields are never required.
 */

export const PAYOUT_ELIGIBILITY_STATUS = {
  ELIGIBLE: "ELIGIBLE",
  MISSING_EARNING_SETTLEMENT: "MISSING_EARNING_SETTLEMENT",
  CAPTURE_PENDING: "CAPTURE_PENDING",
  CAPTURE_MISMATCH: "CAPTURE_MISMATCH",
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
  "DRIVER_TIP_CREDIT",
  "TIP_CREDIT",
]);

export const DES_SOURCE_WALLET_CREDIT = "REVOLUT_WALLET_CREDIT";
export const DES_SOURCE_PHASE1_BACKFILL = "REVOLUT_PHASE1_BACKFILL";
export const DES_FORMULA_VERSION = "payout_eligibility_v1";

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
  payout_processing?: boolean;
  /** Companion DES row present (audit only — not required for Revolut eligibility). */
  des_present?: boolean;
  des_eligible_for_payout?: boolean | null;
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
  pending_balance_pence: number;
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
  payouts_enabled?: boolean | null;
  payout_provider_available?: boolean | null;
  account_verified?: boolean | null;
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
  const settled = Boolean(args.settlement_formula_version)
    || Boolean(args.completed_at)
    || capturedStatus;

  return settled ? "BALANCED" : null;
}

/**
 * Evaluate one balance-affecting earning credit.
 * Does not require DES. Does not require Stripe fields.
 */
export function evaluateLedgerEntryEligibility(
  entry: LedgerEligibilityEvidence,
): { status: PayoutEligibilityStatus; payable_pence: number } {
  const amount = Math.max(0, Math.round(Number(entry.amount_pence ?? 0)));
  const type = String(entry.ledger_type ?? "").toUpperCase();

  if (!PAYOUT_ELIGIBLE_LEDGER_TYPES.has(type) || amount <= 0) {
    return { status: PAYOUT_ELIGIBILITY_STATUS.UNKNOWN_ELIGIBILITY_ERROR, payable_pence: 0 };
  }

  if (entry.paid_in_batch_id || entry.allocated_to_payout === true) {
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

  return { status: PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE, payable_pence: payable };
}

/**
 * Aggregate per-driver payout eligibility from evaluated ledger evidence.
 * available = min(live, eligible_sum) − debt − in_flight (floored at 0).
 */
export function aggregateDriverPayoutEligibility(
  input: AggregateDriverPayoutEligibilityInput,
): DriverPayoutEligibilityResult {
  const live = Math.round(Number(input.live_balance_pence ?? 0));
  const debt = Math.max(0, Math.round(Number(input.outstanding_debt_pence ?? 0)));
  const inFlight = Math.max(0, Math.round(Number(input.in_flight_cashout_pence ?? 0)));

  const eligible_entries: EligiblePayoutEntry[] = [];
  const held_entries: HeldPayoutEntry[] = [];

  if (input.payouts_enabled === false) {
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
      outstanding_debt_pence: debt,
      eligible_earnings_pence: 0,
      eligible_entries,
      held_entries,
      primary_hold_reason: PAYOUT_ELIGIBILITY_STATUS.ADMIN_HOLD,
    };
  }

  if (input.payout_provider_available === false) {
    for (const entry of input.entries) {
      const amount = Math.max(0, Math.round(Number(entry.amount_pence ?? 0)));
      if (amount <= 0 || !PAYOUT_ELIGIBLE_LEDGER_TYPES.has(String(entry.ledger_type ?? "").toUpperCase())) {
        continue;
      }
      held_entries.push({
        ledger_entry_id: entry.ledger_entry_id,
        trip_id: entry.trip_id,
        amount_pence: amount,
        hold_reason: PAYOUT_ELIGIBILITY_STATUS.PAYOUT_PROVIDER_UNAVAILABLE,
      });
    }
    return {
      live_balance_pence: live,
      available_balance_pence: 0,
      pending_balance_pence: Math.max(0, live),
      outstanding_debt_pence: debt,
      eligible_earnings_pence: 0,
      eligible_entries,
      held_entries,
      primary_hold_reason: PAYOUT_ELIGIBILITY_STATUS.PAYOUT_PROVIDER_UNAVAILABLE,
    };
  }

  if (input.account_verified === false) {
    for (const entry of input.entries) {
      const amount = Math.max(0, Math.round(Number(entry.amount_pence ?? 0)));
      if (amount <= 0 || !PAYOUT_ELIGIBLE_LEDGER_TYPES.has(String(entry.ledger_type ?? "").toUpperCase())) {
        continue;
      }
      held_entries.push({
        ledger_entry_id: entry.ledger_entry_id,
        trip_id: entry.trip_id,
        amount_pence: amount,
        hold_reason: PAYOUT_ELIGIBILITY_STATUS.ACCOUNT_UNVERIFIED,
      });
    }
    return {
      live_balance_pence: live,
      available_balance_pence: 0,
      pending_balance_pence: Math.max(0, live),
      outstanding_debt_pence: debt,
      eligible_earnings_pence: 0,
      eligible_entries,
      held_entries,
      primary_hold_reason: PAYOUT_ELIGIBILITY_STATUS.ACCOUNT_UNVERIFIED,
    };
  }

  let eligibleSum = 0;
  for (const entry of input.entries) {
    const { status, payable_pence } = evaluateLedgerEntryEligibility(entry);
    if (status === PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE) {
      eligibleSum += payable_pence;
      eligible_entries.push({
        ledger_entry_id: entry.ledger_entry_id,
        trip_id: entry.trip_id,
        amount_pence: payable_pence,
        eligibility_status: PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE,
        des_companion_missing: entry.des_present !== true,
      });
    } else if (payable_pence > 0 || PAYOUT_ELIGIBLE_LEDGER_TYPES.has(String(entry.ledger_type ?? "").toUpperCase())) {
      held_entries.push({
        ledger_entry_id: entry.ledger_entry_id,
        trip_id: entry.trip_id,
        amount_pence: Math.max(payable_pence, Math.max(0, Math.round(Number(entry.amount_pence ?? 0)))),
        hold_reason: status as HeldPayoutEntry["hold_reason"],
      });
    }
  }

  let available = Math.max(0, Math.min(Math.max(0, live), eligibleSum) - debt - inFlight);

  // Debt recovery can wipe available even when entries are otherwise eligible.
  let primary: DriverPayoutEligibilityResult["primary_hold_reason"] = null;
  if (available <= 0 && live > 0) {
    if (debt > 0 && eligibleSum > 0 && Math.min(Math.max(0, live), eligibleSum) - debt <= 0) {
      primary = PAYOUT_ELIGIBILITY_STATUS.DEBT_RECOVERY;
      available = 0;
    } else if (held_entries.length > 0) {
      primary = held_entries[0]!.hold_reason;
    } else if (eligibleSum <= 0) {
      primary = PAYOUT_ELIGIBILITY_STATUS.UNKNOWN_ELIGIBILITY_ERROR;
    }
  }

  return {
    live_balance_pence: live,
    available_balance_pence: available,
    pending_balance_pence: Math.max(0, live - available),
    outstanding_debt_pence: debt,
    eligible_earnings_pence: eligibleSum,
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
