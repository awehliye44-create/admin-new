/**
 * Financial Reconciliation SSOT — audit/reconcile engine.
 *
 * Payment Sessions owns customer payment amounts (authorised / captured / released /
 * refunded / fees). FR consumes those values and must never invent or recalculate them.
 *
 * Other canonical sources:
 * - trips (commission, driver earnings)
 * - driver_wallet_ledger (paid out, adjustments)
 * - provider balance API (digital positions only)
 */

import { computeLedgerWalletBalancePence } from "./onecabFinanceLedger.ts";

export const SSOT_VERSION = "financial_reconciliation_ssot_v5";

/** Default digital reconciliation tolerance — hard block only when unexplained or negative. */
export const RECONCILIATION_VARIANCE_TOLERANCE_PENCE = 100;

/**
 * Regions with Phase 3C.1–classified positive variance may receive soft warnings
 * instead of hard payout blocks (MK verification fleet).
 */
export const PAYOUT_SOFT_CLASSIFIED_VARIANCE_REGION_IDS = new Set([
  "7f611e59-a9e5-42c2-b65a-61376910bb5d",
]);

export const PAYOUT_SOFT_WARNING_RECONCILIATION =
  "Reconciliation variance within expected timing — payouts use finance-cleared amounts";

export type FinanceDataSourceBadge = "LIVE" | "SUMMARY" | "LEDGER" | "RECONSTRUCTED";

export type ReconciliationVarianceClass =
  | "balanced"
  | "soft_positive_classified"
  | "hard_mismatch";

export function classifyReconciliationVariance(args: {
  reconciliationStatus: "BALANCED" | "RECONCILIATION_MISMATCH";
  variancePence: number;
  sourceTier: FinanceDataSourceBadge;
  regionId?: string | null;
  tolerancePence?: number;
}): ReconciliationVarianceClass {
  const tolerance = args.tolerancePence ?? RECONCILIATION_VARIANCE_TOLERANCE_PENCE;
  if (args.reconciliationStatus === "BALANCED" || Math.abs(args.variancePence) <= tolerance) {
    return "balanced";
  }
  if (
    args.variancePence > tolerance &&
    args.variancePence > 0 &&
    args.sourceTier === "LIVE" &&
    args.regionId &&
    PAYOUT_SOFT_CLASSIFIED_VARIANCE_REGION_IDS.has(args.regionId)
  ) {
    return "soft_positive_classified";
  }
  return "hard_mismatch";
}

export const PAYOUT_DEBIT_LEDGER_TYPES = [
  "PAYOUT",
  "WEEKLY_PAYOUT",
  "EARLY_CASHOUT",
  "MANUAL_PAYOUT",
] as const;

/** Bank / weekly payouts only — early cashouts tracked separately in driver_early_cashouts. */
export const BANK_PAYOUT_LEDGER_TYPES = [
  "PAYOUT",
  "WEEKLY_PAYOUT",
  "MANUAL_PAYOUT",
] as const;

export const ADJUSTMENT_LEDGER_TYPES = [
  "ADJUSTMENT",
  "BONUS",
  "REFUND_DEBIT",
  "DEBT_RECOVERY",
] as const;

export const CAPTURED_PAYMENT_STATUSES = new Set(["captured", "paid", "succeeded"]);

/** Trip-level payment_status values that confirm Stripe capture (card trips). */
export const CAPTURE_CONFIRMED_TRIP_PAYMENT_STATUSES = CAPTURED_PAYMENT_STATUSES;

export type CustomerRevenueSourceLabel =
  | "payment_sessions_captured"
  | "payments_captured"
  | "expected_pending_stripe_confirmation"
  | "trips_capture_fallback_pending"
  | "trips_final_fare_fallback_pending";

export type PaymentCaptureRow = {
  captured_amount_pence: number | null;
  status: string | null;
  trip_id?: string | null;
};

/** Payment Sessions money fields FR may consume — never invent from trips/payments. */
export type PaymentSessionMoneyRow = {
  id?: string | null;
  trip_id?: string | null;
  status?: string | null;
  captured_amount_pence?: number | null;
  authorised_amount_pence?: number | null;
  total_authorised_amount_pence?: number | null;
  released_amount_pence?: number | null;
  refunded_amount_pence?: number | null;
  provider_processing_fee_pence?: number | null;
  fee_status?: string | null;
  provider_state?: string | null;
  provider_state_verified_at?: string | null;
  release_evidence_status?: string | null;
  release_evidence_source?: string | null;
  release_verified_at?: string | null;
  payment_method?: string | null;
  /** May include capture_breakdown owned by Payment Sessions. */
  metadata?: Record<string, unknown> | null;
};

export type PaymentSessionMoneyByTrip = {
  payment_session_id: string | null;
  captured_amount_pence: number | null;
  authorised_amount_pence: number | null;
  released_amount_pence: number | null;
  refunded_amount_pence: number | null;
  provider_processing_fee_pence: number | null;
  fee_status: string | null;
  provider_state: string | null;
  provider_state_verified_at: string | null;
  release_evidence_status: string | null;
  payment_method: string | null;
  status: string | null;
  metadata?: Record<string, unknown> | null;
};

/** Confirmed capture only — never invent £0; never treat 0 as confirmed. */
export function confirmedCapturePence(amount: number | null | undefined): number | null {
  if (amount == null) return null;
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function nonNegativeMoneyPence(amount: number | null | undefined): number | null {
  if (amount == null) return null;
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/** Aggregate Payment Sessions money per trip — FR consume-only map. */
export function buildPaymentSessionMoneyByTrip(
  sessions: PaymentSessionMoneyRow[],
): Map<string, PaymentSessionMoneyByTrip> {
  const byTrip = new Map<string, PaymentSessionMoneyByTrip>();
  for (const s of sessions) {
    if (!s.trip_id) continue;
    const existing = byTrip.get(s.trip_id);
    const captured = confirmedCapturePence(s.captured_amount_pence);
    const authorised = nonNegativeMoneyPence(
      s.total_authorised_amount_pence ?? s.authorised_amount_pence,
    );
    const released = nonNegativeMoneyPence(s.released_amount_pence);
    const refunded = nonNegativeMoneyPence(s.refunded_amount_pence);
    const fee = confirmedCapturePence(s.provider_processing_fee_pence);
    const sessionId = s.id ?? null;
    const feeStatus = s.fee_status ?? null;
    const providerState = s.provider_state ?? null;
    const providerVerifiedAt = s.provider_state_verified_at ?? null;
    const releaseEvidenceStatus = s.release_evidence_status ?? null;
    const paymentMethod = s.payment_method ?? null;
    const metadata = (s.metadata && typeof s.metadata === "object")
      ? s.metadata as Record<string, unknown>
      : null;
    if (!existing) {
      byTrip.set(s.trip_id, {
        payment_session_id: sessionId,
        captured_amount_pence: captured,
        authorised_amount_pence: authorised,
        released_amount_pence: released,
        refunded_amount_pence: refunded,
        provider_processing_fee_pence: fee,
        fee_status: feeStatus,
        provider_state: providerState,
        provider_state_verified_at: providerVerifiedAt,
        release_evidence_status: releaseEvidenceStatus,
        payment_method: paymentMethod,
        status: s.status ?? null,
        metadata,
      });
      continue;
    }
    // Prefer session id that carries confirmed capture evidence.
    const preferNewId = captured != null && existing.captured_amount_pence == null;
    byTrip.set(s.trip_id, {
      payment_session_id: preferNewId
        ? sessionId
        : (existing.payment_session_id ?? sessionId),
      captured_amount_pence:
        captured == null
          ? existing.captured_amount_pence
          : (existing.captured_amount_pence ?? 0) + captured,
      authorised_amount_pence:
        authorised == null
          ? existing.authorised_amount_pence
          : Math.max(existing.authorised_amount_pence ?? 0, authorised),
      released_amount_pence:
        released == null
          ? existing.released_amount_pence
          : (existing.released_amount_pence ?? 0) + released,
      refunded_amount_pence:
        refunded == null
          ? existing.refunded_amount_pence
          : (existing.refunded_amount_pence ?? 0) + refunded,
      provider_processing_fee_pence:
        fee == null
          ? existing.provider_processing_fee_pence
          : (existing.provider_processing_fee_pence ?? 0) + fee,
      fee_status: existing.fee_status ?? feeStatus,
      provider_state: preferNewId ? providerState : (existing.provider_state ?? providerState),
      provider_state_verified_at: preferNewId
        ? providerVerifiedAt
        : (existing.provider_state_verified_at ?? providerVerifiedAt),
      release_evidence_status: preferNewId
        ? releaseEvidenceStatus
        : (existing.release_evidence_status ?? releaseEvidenceStatus),
      payment_method: existing.payment_method ?? paymentMethod,
      status: s.status ?? existing.status,
      metadata: preferNewId ? metadata : (existing.metadata ?? metadata),
    });
  }
  return byTrip;
}

/**
 * Payment Sessions confirmed captures only.
 * Legacy `payments` must never invent customer capture for Financial Reconciliation.
 */
export function mergePaymentSessionsIntoCaptureRows(args: {
  paymentSessions: PaymentSessionMoneyRow[];
  /** Ignored — kept for call-site compat. Never used for customer money. */
  legacyPayments?: PaymentCaptureRow[];
}): { rows: PaymentCaptureRow[]; source: CustomerRevenueSourceLabel } {
  const byTrip = new Map<string, number>();
  for (const s of args.paymentSessions) {
    if (!s.trip_id) continue;
    const amt = confirmedCapturePence(s.captured_amount_pence);
    if (amt == null) continue;
    byTrip.set(s.trip_id, (byTrip.get(s.trip_id) ?? 0) + amt);
  }

  const rows: PaymentCaptureRow[] = [];
  for (const [trip_id, captured_amount_pence] of byTrip) {
    rows.push({ trip_id, captured_amount_pence, status: "captured" });
  }

  return {
    rows,
    source: "payment_sessions_captured",
  };
}

export type TripSSOTRow = {
  id?: string | null;
  commission_pence: number | null;
  stripe_processing_fee_pence: number | null;
  onecab_net_pence: number | null;
  driver_net_pence: number | null;
  gross_fare_pence: number | null;
  final_fare_pence: number | null;
  commissionable_fare_pence: number | null;
  capture_amount_pence: number | null;
  refund_amount_pence?: number | null;
  payment_status?: string | null;
  pickup_waiting_charge_pence?: number | null;
  stop_waiting_charge_pence?: number | null;
  tip_pence?: number | null;
  tip_amount_pence?: number | null;
  airport_charge_pence?: number | null;
  other_pass_through_charges_pence?: number | null;
  payment_method?: string | null;
};

export function isTripPaymentCaptureConfirmed(
  trip: TripSSOTRow,
  paymentByTrip: Map<string, number>,
): boolean {
  const tripId = trip.id ?? "";
  // Payment Sessions (via paymentByTrip) only — never trips.capture_amount_pence.
  const fromSessions = tripId !== "" ? (paymentByTrip.get(tripId) ?? 0) : 0;
  return fromSessions > 0;
}

export function partitionTripsForReconciliation(args: {
  trips: TripSSOTRow[];
  payments: PaymentCaptureRow[];
}): {
  reconciledTrips: TripSSOTRow[];
  pendingTrips: TripSSOTRow[];
  paymentByTrip: Map<string, number>;
} {
  const paymentByTrip = sumCapturedPaymentsByTripId(args.payments);
  const reconciledTrips: TripSSOTRow[] = [];
  const pendingTrips: TripSSOTRow[] = [];

  for (const trip of args.trips) {
    if (isTripPaymentCaptureConfirmed(trip, paymentByTrip)) {
      reconciledTrips.push(trip);
    } else {
      pendingTrips.push(trip);
    }
  }

  return { reconciledTrips, pendingTrips, paymentByTrip };
}

/** Reduce commission/driver amounts when trip has partial/full refund. */
export function applyRefundToTripAmounts(args: {
  capturedPence: number;
  refundPence: number;
  commissionPence: number;
  driverNetPence: number;
}): {
  net_captured_pence: number;
  commission_pence: number;
  driver_net_pence: number;
} {
  const captured = Math.max(0, args.capturedPence);
  const refund = Math.max(0, args.refundPence);
  const netCaptured = Math.max(0, captured - refund);
  if (captured <= 0 || refund <= 0) {
    return {
      net_captured_pence: netCaptured,
      commission_pence: Math.max(0, args.commissionPence),
      driver_net_pence: Math.max(0, args.driverNetPence),
    };
  }
  const ratio = netCaptured / captured;
  return {
    net_captured_pence: netCaptured,
    commission_pence: Math.max(0, Math.round(args.commissionPence * ratio)),
    driver_net_pence: Math.max(0, Math.round(args.driverNetPence * ratio)),
  };
}

export type LedgerSSOTRow = {
  type: string;
  amount_pence: number;
};

/** Driver gross earnings from trips — use final_fare_pence (authoritative customer payable ex tips). */
export function tripDriverGrossEarningsPence(row: TripSSOTRow): number {
  const fare = Math.max(
    0,
    row.final_fare_pence ?? row.commissionable_fare_pence ?? 0,
  );
  const pickupWaiting = Math.max(0, row.pickup_waiting_charge_pence ?? 0);
  const stopWaiting = Math.max(0, row.stop_waiting_charge_pence ?? 0);
  const tips = Math.max(0, row.tip_pence ?? row.tip_amount_pence ?? 0);
  const airport = Math.max(0, row.airport_charge_pence ?? 0);
  const passThrough = Math.max(0, row.other_pass_through_charges_pence ?? 0);
  return fare + pickupWaiting + stopWaiting + tips + airport + passThrough;
}

/** 1. Total customer revenue — Payment Sessions confirmed captures only (upstream merge). */
export function sumCustomerRevenuePence(args: {
  payments: PaymentCaptureRow[];
  trips: TripSSOTRow[];
}): { total_pence: number; source: CustomerRevenueSourceLabel } {
  const fromSessions = args.payments
    .filter((p) => CAPTURED_PAYMENT_STATUSES.has(String(p.status ?? "").toLowerCase()))
    .reduce((s, p) => {
      const amt = confirmedCapturePence(p.captured_amount_pence);
      return amt == null ? s : s + amt;
    }, 0);

  return { total_pence: fromSessions, source: "payment_sessions_captured" };
}

/**
 * Pending capture revenue — never invent from trip capture/fare.
 * Without Payment Sessions capture evidence the amount is unknown (0 pending invent).
 */
export function sumPendingStripeConfirmationRevenuePence(_args: {
  pendingTrips: TripSSOTRow[];
}): number {
  return 0;
}

/** 2. Refunded amount — prefer Payment Sessions when provided. */
export function sumRefundedPence(rows: Array<{ refund_amount_pence?: number | null }>): number {
  return rows.reduce((s, r) => s + Math.max(0, r.refund_amount_pence ?? 0), 0);
}

export function sumRefundedFromPaymentSessions(
  sessionByTrip: Map<string, PaymentSessionMoneyByTrip>,
): number {
  let total = 0;
  for (const row of sessionByTrip.values()) {
    total += Math.max(0, row.refunded_amount_pence ?? 0);
  }
  return total;
}

/** 3. Net customer revenue */
export function netCustomerRevenuePence(total: number, refunded: number): number {
  return Math.max(0, total - refunded);
}



export function tripTipsPence(row: TripSSOTRow): number {
  return Math.max(0, row.tip_pence ?? row.tip_amount_pence ?? 0);
}

export function isDigitalTripPaymentMethod(paymentMethod: string | null | undefined): boolean {
  return (paymentMethod ?? '').trim().length > 0;
}

export function filterDigitalTrips<T extends { payment_method?: string | null }>(trips: T[]): T[] {
  return trips.filter((t) => isDigitalTripPaymentMethod(t.payment_method));
}

/** Sum captured payment rows per trip (primary PI + shortfall/extra recovery PIs). */
export function sumCapturedPaymentsByTripId(
  payments: PaymentCaptureRow[],
): Map<string, number> {
  const byTrip = new Map<string, number>();
  for (const p of payments) {
    if (!p.trip_id) continue;
    if (!CAPTURED_PAYMENT_STATUSES.has(String(p.status ?? "").toLowerCase())) continue;
    const cap = confirmedCapturePence(p.captured_amount_pence);
    if (cap == null) continue;
    byTrip.set(p.trip_id, (byTrip.get(p.trip_id) ?? 0) + cap);
  }
  return byTrip;
}

/** Digital customer revenue — captured payments on digital trips. */
export function sumDigitalCustomerRevenuePence(args: {
  payments: PaymentCaptureRow[];
  digitalTripIds: Set<string>;
}): number {
  return args.payments
    .filter((p) => p.trip_id && args.digitalTripIds.has(p.trip_id))
    .filter((p) => CAPTURED_PAYMENT_STATUSES.has(String(p.status ?? "").toLowerCase()))
    .reduce((s, p) => {
      const amt = confirmedCapturePence(p.captured_amount_pence);
      return amt == null ? s : s + amt;
    }, 0);
}

export function sumDigitalNetCustomerRevenuePence(args: {
  payments: PaymentCaptureRow[];
  digitalTrips: Array<{ id?: string; refund_amount_pence?: number | null }>;
}): number {
  const digitalTripIds = new Set(
    args.digitalTrips.map((t) => t.id).filter((id): id is string => Boolean(id)),
  );
  const captured = sumDigitalCustomerRevenuePence({
    payments: args.payments,
    digitalTripIds,
  });
  const refunded = sumRefundedPence(args.digitalTrips);
  return netCustomerRevenuePence(captured, refunded);
}

/** 5. ONECAB gross commission — capture-confirmed trips only */
export function sumOnecabGrossCommissionPence(
  trips: TripSSOTRow[],
  paymentByTrip?: Map<string, number>,
  refundByTrip?: Map<string, number>,
): number {
  const byTrip = paymentByTrip ?? new Map<string, number>();
  return trips.reduce((s, t) => {
    if (!isTripPaymentCaptureConfirmed(t, byTrip)) return s;
    const tripId = t.id ?? "";
    const refund = refundByTrip?.get(tripId)
      ?? Math.max(0, t.refund_amount_pence ?? 0);
    // Captured amount from Payment Sessions only — never trips.capture_amount_pence.
    const captured = byTrip.get(tripId) ?? 0;
    const adjusted = applyRefundToTripAmounts({
      capturedPence: captured,
      refundPence: refund,
      commissionPence: Math.max(0, t.commission_pence ?? 0),
      driverNetPence: Math.max(0, t.driver_net_pence ?? 0),
    });
    return s + adjusted.commission_pence;
  }, 0);
}

/**
 * 6. Provider processing fees — Payment Sessions only when feeByTrip provided.
 * Never invent fees from trip columns when sessions are the SSOT.
 */
export function sumProviderProcessingFeesPence(
  trips: TripSSOTRow[],
  paymentByTrip?: Map<string, number>,
  feeByTrip?: Map<string, number>,
): number {
  const byTrip = paymentByTrip ?? new Map<string, number>();
  return trips.reduce((s, t) => {
    if (!isTripPaymentCaptureConfirmed(t, byTrip)) return s;
    const tripId = t.id ?? "";
    if (feeByTrip) {
      return s + Math.max(0, feeByTrip.get(tripId) ?? 0);
    }
    return s + tripProviderProcessingFeePence(t);
  }, 0);
}

/** 7. ONECAB net commission */
export function onecabNetCommissionPence(gross: number, providerFees: number): number {
  return Math.max(0, gross - providerFees);
}

/** 8. Driver net earnings — stored trips.driver_net_pence only (never invent gross − commission). */
export function sumDriverNetEarningsPence(
  trips: TripSSOTRow[],
  paymentByTrip?: Map<string, number>,
  refundByTrip?: Map<string, number>,
): number {
  const byTrip = paymentByTrip ?? new Map<string, number>();
  return trips.reduce((s, t) => {
    if (!isTripPaymentCaptureConfirmed(t, byTrip)) {
      return s;
    }
    if (t.driver_net_pence == null) return s;
    const tripId = t.id ?? "";
    const refund = refundByTrip?.get(tripId)
      ?? Math.max(0, t.refund_amount_pence ?? 0);
    const captured = byTrip.get(tripId) ?? 0;
    // Refunds: consume stored net; only ratio-adjust when capture evidence present and refund > 0.
    // Never invent net from gross − commission.
    if (refund > 0 && captured > 0) {
      const adjusted = applyRefundToTripAmounts({
        capturedPence: captured,
        refundPence: refund,
        commissionPence: Math.max(0, t.commission_pence ?? 0),
        driverNetPence: Math.max(0, t.driver_net_pence),
      });
      return s + adjusted.driver_net_pence;
    }
    return s + Math.max(0, t.driver_net_pence);
  }, 0);
}

export function sumDriverGrossEarningsPence(trips: TripSSOTRow[]): number {
  return trips.reduce((s, t) => s + tripDriverGrossEarningsPence(t), 0);
}

/** 9. Driver paid out — all ledger payout debits (platform totals). */
export function sumDriverPaidOutPence(ledger: LedgerSSOTRow[]): number {
  return ledger
    .filter((r) => PAYOUT_DEBIT_LEDGER_TYPES.includes(r.type as (typeof PAYOUT_DEBIT_LEDGER_TYPES)[number]))
    .reduce((s, r) => s + Math.abs(r.amount_pence ?? 0), 0);
}

/** Per-driver bank payouts — excludes EARLY_CASHOUT ledger rows. */
export function sumBankPayoutPaidOutPence(ledger: LedgerSSOTRow[]): number {
  return ledger
    .filter((r) => BANK_PAYOUT_LEDGER_TYPES.includes(r.type as (typeof BANK_PAYOUT_LEDGER_TYPES)[number]))
    .reduce((s, r) => s + Math.abs(r.amount_pence ?? 0), 0);
}

/** Ledger adjustments */
export function sumAdjustmentsPence(ledger: LedgerSSOTRow[]): number {
  return ledger
    .filter((r) => ADJUSTMENT_LEDGER_TYPES.includes(r.type as (typeof ADJUSTMENT_LEDGER_TYPES)[number]))
    .reduce((s, r) => s + (r.amount_pence ?? 0), 0);
}

/** 10. Driver remaining liability (platform). */
export function driverRemainingLiabilityPence(args: {
  driverNetEarningsPence: number;
  driverPaidOutPence: number;
  adjustmentsPence: number;
}): number {
  return Math.max(
    0,
    args.driverNetEarningsPence - args.driverPaidOutPence + args.adjustmentsPence,
  );
}

/**
 * @deprecated Phase 3A.4 — trip-based liability inflated earnings.
 * Use perDriverLedgerLiabilityPence() for allocation, reconciliation, and payout gating.
 */
export function perDriverRemainingLiabilityPence(args: {
  driverNetEarningsPence: number;
  bankPaidOutPence: number;
  completedEarlyCashoutsPence: number;
  adjustmentsPence: number;
}): number {
  return Math.max(
    0,
    args.driverNetEarningsPence -
      args.bankPaidOutPence -
      args.completedEarlyCashoutsPence +
      args.adjustmentsPence,
  );
}

/**
 * Phase 3A.4 — digital driver liability SSOT.
 * Wallet ledger balance excluding PLATFORM_COMMISSION.
 * Payout / early-cashout debits are already netted in the ledger sum.
 */
export function perDriverLedgerLiabilityPence(ledger: LedgerSSOTRow[]): number {
  return Math.max(0, computeLedgerWalletBalancePence(ledger));
}

// NOTE: legacy `driverAvailableNowPence` and `perDriverAvailableNowPence` have
// Legacy wallet→payout derivations removed. Use per-driver SSOT (computePayoutEligibility).
// in `payoutAvailability.ts` — applied directly in computeSSOTMetrics and
// computePerDriverSSOT.

/** Allocate platform provider balance across drivers by settled eligible liability. */
export function allocateProviderBalanceByLiability(args: {
  providerAvailableBalancePence: number;
  driverLiabilities: Record<string, number>;
}): Record<string, number> {
  const entries = Object.entries(args.driverLiabilities);
  const totalLiability = entries.reduce((s, [, v]) => s + Math.max(0, v), 0);
  const result: Record<string, number> = {};

  if (totalLiability <= 0 || args.providerAvailableBalancePence <= 0) {
    for (const [driverId] of entries) result[driverId] = 0;
    return result;
  }

  if (entries.length === 1) {
    result[entries[0][0]] = args.providerAvailableBalancePence;
    return result;
  }

  let allocated = 0;
  for (let i = 0; i < entries.length; i++) {
    const [driverId, liability] = entries[i];
    if (i === entries.length - 1) {
      result[driverId] = Math.max(0, args.providerAvailableBalancePence - allocated);
    } else {
      const share = Math.floor(
        (args.providerAvailableBalancePence * Math.max(0, liability)) / totalLiability,
      );
      result[driverId] = share;
      allocated += share;
    }
  }
  return result;
}

// NOTE: legacy `driverPendingPayoutPence` removed. Under the SSOT
// (available_payout = max(walletBalance,0)) pending is always 0 — the wallet
// is either available or it's debt. Pending-payout fields are kept in output
// types for UI compatibility and pinned to 0.

/**
 * Phase 3A.6 — digital-scoped reconciliation identity.
 *
 * Digital revenue captured
 *   = driver wallet liability (post-payout ledger)
 *   + ONECAB net commission (digital trips only)
 *   + provider fees (digital trips only)
 *   + bank paid out (0 when liability is post-payout ledger)
 *   + completed early cashouts (0 when liability is post-payout ledger)
 *
 * Digital-only platform — all trips are card/wallet.
 */
export function buildDigitalReconciliationCheck(args: {
  digitalNetCustomerRevenuePence: number;
  driverWalletLiabilityPence: number;
  digitalOnecabNetCommissionPence: number;
  digitalProviderProcessingFeePence: number;
  bankPaidOutPence: number;
  completedEarlyCashoutsPence: number;
  tolerancePence?: number;
  /** Ledger wallet SSOT nets payout/cashout debits — do not add paid-out terms to RHS. */
  walletLiabilityIsPostPayout?: boolean;
}) {
  const walletIsPostPayout = args.walletLiabilityIsPostPayout !== false;
  const paidOutRhs = walletIsPostPayout ? 0 : Math.max(0, args.bankPaidOutPence);
  const earlyCashoutRhs = walletIsPostPayout ? 0 : Math.max(0, args.completedEarlyCashoutsPence);
  const rhs =
    args.driverWalletLiabilityPence +
    args.digitalOnecabNetCommissionPence +
    args.digitalProviderProcessingFeePence +
    paidOutRhs +
    earlyCashoutRhs;
  const variance = args.digitalNetCustomerRevenuePence - rhs;
  const tolerance = args.tolerancePence ?? RECONCILIATION_VARIANCE_TOLERANCE_PENCE;
  const balanced = Math.abs(variance) <= tolerance;

  return {
    digital_net_customer_revenue_pence: args.digitalNetCustomerRevenuePence,
    driver_wallet_liability_pence: args.driverWalletLiabilityPence,
    digital_onecab_net_commission_pence: args.digitalOnecabNetCommissionPence,
    digital_provider_processing_fee_pence: args.digitalProviderProcessingFeePence,
    bank_paid_out_pence: args.bankPaidOutPence,
    completed_early_cashouts_pence: args.completedEarlyCashoutsPence,
    bank_paid_out_rhs_pence: paidOutRhs,
    completed_early_cashouts_rhs_pence: earlyCashoutRhs,
    expected_sum_pence: rhs,
    variance_pence: variance,
    delta_pence: variance,
    balanced,
    status: balanced ? ("BALANCED" as const) : ("RECONCILIATION_MISMATCH" as const),
    reconciliation_scope: "digital_v3" as const,
  };
}

/**
 * @deprecated Phase 3A.6 — use buildDigitalReconciliationCheck for payout gating.
 * Legacy all-trip ONECAB scope.
 */
export function buildReconciliationCheck(args: {
  netCustomerRevenuePence: number;
  driverPaidOutPence: number;
  driverRemainingLiabilityPence: number;
  onecabNetCommissionPence: number;
  providerProcessingFeePence: number;
  adjustmentsPence: number;
  tolerancePence?: number;
}) {
  const adjustmentsRhs = args.driverPaidOutPence > 0 ? 0 : args.adjustmentsPence;
  const rhs =
    args.driverPaidOutPence +
    args.driverRemainingLiabilityPence +
    args.onecabNetCommissionPence +
    args.providerProcessingFeePence +
    adjustmentsRhs;
  const variance = args.netCustomerRevenuePence - rhs;
  const tolerance = args.tolerancePence ?? 100;
  const balanced = Math.abs(variance) <= tolerance;

  return {
    net_customer_revenue_pence: args.netCustomerRevenuePence,
    driver_paid_out_pence: args.driverPaidOutPence,
    driver_remaining_liability_pence: args.driverRemainingLiabilityPence,
    onecab_net_commission_pence: args.onecabNetCommissionPence,
    provider_processing_fee_pence: args.providerProcessingFeePence,
    adjustments_pence: args.adjustmentsPence,
    expected_sum_pence: rhs,
    variance_pence: variance,
    delta_pence: variance,
    balanced,
    status: balanced ? ("BALANCED" as const) : ("RECONCILIATION_MISMATCH" as const),
  };
}

export type SSOTComputedMetrics = {
  total_customer_revenue_pence: number;
  customer_revenue_source: CustomerRevenueSourceLabel;
  refunded_amount_pence: number;
  net_customer_revenue_pence: number;
  pending_stripe_confirmation_revenue_pence: number;
  pending_stripe_confirmation_commission_pence: number;
  pending_stripe_confirmation_driver_net_pence: number;
  pending_trip_count: number;
  driver_gross_earnings_pence: number;
  driver_net_earnings_pence: number;
  onecab_gross_commission_pence: number;
  provider_processing_fee_pence: number;
  onecab_net_commission_pence: number;
  driver_paid_out_pence: number;
  adjustments_pence: number;
  driver_remaining_liability_pence: number;
  driver_available_now_pence: number;
  driver_pending_payout_pence: number;
  provider_available_balance_pence: number;
  provider_pending_balance_pence: number;
  ledger_split: PaymentMethodLedgerMetrics;
  total_commission_earned_pence: number;
  net_platform_revenue_pence: number;
  onecab_card_net_commission_pence: number;
};

/** Digital payment method ledger metrics for Financial Reconciliation UI. */
export type PaymentMethodLedgerMetrics = {
  card_customer_revenue_pence: number;
  net_card_revenue_pence: number;
  card_driver_payable_pence: number;
  onecab_card_commission_pence: number;
  onecab_card_net_commission_pence: number;
  stripe_processing_fees_pence: number;
  /** Alias — same value as stripe_processing_fees_pence for API compat. */
  provider_processing_fees_pence: number;
  /** Completed card trips not yet capture-confirmed — not reconciled totals. */
  pending_stripe_confirmation_revenue_pence: number;
  pending_stripe_confirmation_commission_pence: number;
  pending_stripe_confirmation_driver_net_pence: number;
  pending_trip_count: number;
};


/** Provider-neutral processing fee — prefers provider_fee_pence when populated. */
export function tripProviderProcessingFeePence(trip: {
  provider_fee_pence?: number | null;
  stripe_processing_fee_pence?: number | null;
}): number {
  const providerFee = trip.provider_fee_pence;
  if (providerFee != null && providerFee > 0) return providerFee;
  return Math.max(0, trip.stripe_processing_fee_pence ?? 0);
}

export function totalCommissionEarnedPence(
  cardCommissionPence: number,
): number {
  return Math.max(0, cardCommissionPence);
}

/** Net platform revenue — Stripe fees apply to card trips only. */
export function netPlatformRevenuePence(
  totalCommissionEarnedPenceValue: number,
  cardStripeFeesPence: number,
): number {
  return Math.max(0, totalCommissionEarnedPenceValue - Math.max(0, cardStripeFeesPence));
}

export function computePaymentMethodLedgerMetrics(args: {
  trips: TripSSOTRow[];
  payments?: PaymentCaptureRow[];
  feeByTrip?: Map<string, number>;
  refundByTrip?: Map<string, number>;
}): PaymentMethodLedgerMetrics {
  const paymentByTrip = sumCapturedPaymentsByTripId(args.payments ?? []);
  const { reconciledTrips, pendingTrips } = partitionTripsForReconciliation({
    trips: args.trips,
    payments: args.payments ?? [],
  });

  const feeByTrip = args.feeByTrip ?? new Map<string, number>();
  const refundByTrip = args.refundByTrip ?? new Map<string, number>();
  let cardCustomerRevenue = 0;
  let cardDriverPayable = 0;
  let onecabCardCommission = 0;
  let cardStripeFees = 0;
  for (const trip of reconciledTrips) {
    const commission = Math.max(0, trip.commission_pence ?? 0);

    const tripId = trip.id ?? "";
    // Payment Sessions capture only — never trips.capture_amount_pence.
    const capturedRaw = tripId && paymentByTrip.has(tripId)
      ? paymentByTrip.get(tripId)!
      : 0;
    const refund = refundByTrip.get(tripId) ?? Math.max(0, trip.refund_amount_pence ?? 0);
    const adjusted = applyRefundToTripAmounts({
      capturedPence: capturedRaw,
      refundPence: refund,
      commissionPence: commission,
      driverNetPence: Math.max(0, trip.driver_net_pence ?? 0),
    });

    cardCustomerRevenue += adjusted.net_captured_pence;
    cardDriverPayable += adjusted.driver_net_pence;
    onecabCardCommission += adjusted.commission_pence;
    if (args.feeByTrip) {
      cardStripeFees += Math.max(0, feeByTrip.get(tripId) ?? 0);
    } else {
      cardStripeFees += tripProviderProcessingFeePence(trip);
    }
  }

  let pendingRevenue = 0;
  let pendingCommission = 0;
  let pendingDriverNet = 0;
  for (const trip of pendingTrips) {
    pendingRevenue += sumPendingStripeConfirmationRevenuePence({ pendingTrips: [trip] });
    pendingCommission += Math.max(0, trip.commission_pence ?? 0);
    pendingDriverNet += Math.max(0, trip.driver_net_pence ?? 0);
  }

  return {
    card_customer_revenue_pence: cardCustomerRevenue,
    net_card_revenue_pence: Math.max(0, cardCustomerRevenue),
    card_driver_payable_pence: cardDriverPayable,
    onecab_card_commission_pence: onecabCardCommission,
    onecab_card_net_commission_pence: onecabNetCommissionPence(onecabCardCommission, cardStripeFees),
    stripe_processing_fees_pence: cardStripeFees,
    provider_processing_fees_pence: cardStripeFees,
    pending_stripe_confirmation_revenue_pence: pendingRevenue,
    pending_stripe_confirmation_commission_pence: pendingCommission,
    pending_stripe_confirmation_driver_net_pence: pendingDriverNet,
    pending_trip_count: pendingTrips.length,
  };
}

function buildLedgerSliceCheck(args: {
  lhs: number;
  rhsComponents: number[];
  tolerancePence?: number;
}) {
  const rhs = args.rhsComponents.reduce((s, v) => s + v, 0);
  const variance = args.lhs - rhs;
  const tolerance = args.tolerancePence ?? RECONCILIATION_VARIANCE_TOLERANCE_PENCE;
  const balanced = Math.abs(variance) <= tolerance;
  return {
    expected_sum_pence: rhs,
    variance_pence: variance,
    delta_pence: variance,
    balanced,
    status: balanced ? ("BALANCED" as const) : ("RECONCILIATION_MISMATCH" as const),
  };
}

export function buildSplitReconciliationCheck(args: {
  ledger: PaymentMethodLedgerMetrics;
  airportChargesPence?: number;
  driverTipsPence?: number;
  tolerancePence?: number;
}) {
  const l = args.ledger;
  // Hard identity: captured = driver_net + gross_commission + airport + tips (zero tolerance).
  const cardBase = buildLedgerSliceCheck({
    lhs: l.card_customer_revenue_pence,
    rhsComponents: [
      l.card_driver_payable_pence,
      l.onecab_card_commission_pence,
      Math.max(0, args.airportChargesPence ?? 0),
      Math.max(0, args.driverTipsPence ?? 0),
    ],
    tolerancePence: 0,
  });
  const card_reconciliation = {
    ...cardBase,
    card_customer_revenue_pence: l.card_customer_revenue_pence,
    card_driver_payable_pence: l.card_driver_payable_pence,
    onecab_card_commission_pence: l.onecab_card_commission_pence,
    airport_charges_pence: Math.max(0, args.airportChargesPence ?? 0),
    driver_tips_pence: Math.max(0, args.driverTipsPence ?? 0),
  };
  return {
    card_reconciliation,
    balanced: card_reconciliation.balanced,
    status: card_reconciliation.balanced ? ("BALANCED" as const) : ("RECONCILIATION_MISMATCH" as const),
  };
}

export function buildTripEarningsReconciliationCheck(args: {
  netCustomerRevenuePence: number;
  driverNetEarningsPence: number;
  onecabGrossCommissionPence: number;
  tipsPence: number;
  tolerancePence?: number;
}) {
  const rhs = args.driverNetEarningsPence + args.onecabGrossCommissionPence + args.tipsPence;
  const variance = args.netCustomerRevenuePence - rhs;
  const tolerance = args.tolerancePence ?? RECONCILIATION_VARIANCE_TOLERANCE_PENCE;
  const balanced = Math.abs(variance) <= tolerance;
  return {
    net_customer_revenue_pence: args.netCustomerRevenuePence,
    driver_net_earnings_pence: args.driverNetEarningsPence,
    onecab_gross_commission_pence: args.onecabGrossCommissionPence,
    tips_pence: args.tipsPence,
    expected_sum_pence: rhs,
    variance_pence: variance,
    delta_pence: variance,
    balanced,
    status: balanced ? ("BALANCED" as const) : ("RECONCILIATION_MISMATCH" as const),
  };
}

export function computeSSOTMetrics(args: {
  payments: PaymentCaptureRow[];
  trips: TripSSOTRow[];
  ledger: LedgerSSOTRow[];
  providerAvailableBalancePence: number;
  providerPendingBalancePence: number;
  /** Payment Sessions money — preferred for refunds and provider fees. */
  paymentSessions?: PaymentSessionMoneyRow[];
}): SSOTComputedMetrics {
  const { reconciledTrips, pendingTrips, paymentByTrip } = partitionTripsForReconciliation({
    trips: args.trips,
    payments: args.payments,
  });

  const sessionByTrip = buildPaymentSessionMoneyByTrip(args.paymentSessions ?? []);
  const feeByTrip = new Map<string, number>();
  const refundByTrip = new Map<string, number>();
  for (const [tripId, money] of sessionByTrip) {
    if (money.provider_processing_fee_pence != null) {
      feeByTrip.set(tripId, money.provider_processing_fee_pence);
    }
    if (money.refunded_amount_pence != null) {
      refundByTrip.set(tripId, money.refunded_amount_pence);
    }
  }
  const hasSessionFees = args.paymentSessions != null;

  const customerRev = sumCustomerRevenuePence({ payments: args.payments, trips: args.trips });
  const refunded = hasSessionFees
    ? sumRefundedFromPaymentSessions(sessionByTrip)
    : sumRefundedPence(args.trips);
  const netCustomer = netCustomerRevenuePence(customerRev.total_pence, refunded);
  const pendingRevenue = sumPendingStripeConfirmationRevenuePence({ pendingTrips });
  const driverGross = sumDriverGrossEarningsPence(reconciledTrips);
  const driverNet = sumDriverNetEarningsPence(reconciledTrips, paymentByTrip, refundByTrip);
  const onecabGross = sumOnecabGrossCommissionPence(reconciledTrips, paymentByTrip, refundByTrip);
  const providerFees = sumProviderProcessingFeesPence(
    reconciledTrips,
    paymentByTrip,
    hasSessionFees ? feeByTrip : undefined,
  );
  const onecabNet = onecabNetCommissionPence(onecabGross, providerFees);
  const paidOut = sumDriverPaidOutPence(args.ledger);
  const adjustments = sumAdjustmentsPence(args.ledger);
  const walletBalance = computeLedgerWalletBalancePence(args.ledger);
  const remaining = Math.max(0, walletBalance);
  // Platform rollup cannot compute per-driver eligible payout — use per-driver SSOT.
  const availableNow = 0;
  const pendingPayout = 0;

  const ledgerSplit = computePaymentMethodLedgerMetrics({
    payments: args.payments,
    trips: args.trips,
    feeByTrip: hasSessionFees ? feeByTrip : undefined,
    refundByTrip: hasSessionFees ? refundByTrip : undefined,
  });
  const totalCommissionEarned = totalCommissionEarnedPence(
    ledgerSplit.onecab_card_commission_pence,
  );
  const netPlatform = netPlatformRevenuePence(
    totalCommissionEarned,
    ledgerSplit.stripe_processing_fees_pence,
  );
  const onecabCardNet = onecabNetCommissionPence(
    ledgerSplit.onecab_card_commission_pence,
    ledgerSplit.stripe_processing_fees_pence,
  );

  return {
    total_customer_revenue_pence: customerRev.total_pence,
    customer_revenue_source: customerRev.source,
    refunded_amount_pence: refunded,
    net_customer_revenue_pence: netCustomer,
    pending_stripe_confirmation_revenue_pence: pendingRevenue,
    pending_stripe_confirmation_commission_pence: ledgerSplit.pending_stripe_confirmation_commission_pence,
    pending_stripe_confirmation_driver_net_pence: ledgerSplit.pending_stripe_confirmation_driver_net_pence,
    pending_trip_count: ledgerSplit.pending_trip_count,
    driver_gross_earnings_pence: driverGross,
    driver_net_earnings_pence: driverNet,
    onecab_gross_commission_pence: onecabGross,
    provider_processing_fee_pence: providerFees,
    onecab_net_commission_pence: onecabNet,
    driver_paid_out_pence: paidOut,
    adjustments_pence: adjustments,
    driver_remaining_liability_pence: remaining,
    driver_available_now_pence: availableNow,
    driver_pending_payout_pence: pendingPayout,
    provider_available_balance_pence: args.providerAvailableBalancePence,
    provider_pending_balance_pence: args.providerPendingBalancePence,
    ledger_split: ledgerSplit,
    total_commission_earned_pence: totalCommissionEarned,
    net_platform_revenue_pence: netPlatform,
    onecab_card_net_commission_pence: onecabCardNet,
  };
}
