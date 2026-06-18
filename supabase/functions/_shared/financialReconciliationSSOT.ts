/**
 * Financial Reconciliation SSOT — canonical finance calculation engine.
 *
 * Financial Reconciliation is the source of truth for calculations and reporting.
 * It calculates from canonical backend sources; it is NOT the raw data store.
 *
 * Canonical sources:
 * - payments (customer revenue)
 * - trips (commission, driver earnings)
 * - driver_wallet_ledger (paid out, adjustments)
 * - provider balance API (cash positions only)
 */

import { computeLedgerWalletBalancePence } from "./onecabFinanceLedger.ts";

export const SSOT_VERSION = "financial_reconciliation_ssot_v3";

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

export type PaymentCaptureRow = {
  captured_amount_pence: number | null;
  status: string | null;
  trip_id?: string | null;
};

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
  pickup_waiting_charge_pence?: number | null;
  stop_waiting_charge_pence?: number | null;
  tip_pence?: number | null;
  tip_amount_pence?: number | null;
  airport_charge_pence?: number | null;
  other_pass_through_charges_pence?: number | null;
  payment_method?: string | null;
};

export type LedgerSSOTRow = {
  type: string;
  amount_pence: number;
};

/** 4. Driver gross earnings from trips (excludes provider fees, commission, auth buffer). */
export function tripDriverGrossEarningsPence(row: TripSSOTRow): number {
  const fare = Math.max(
    0,
    row.gross_fare_pence ?? row.final_fare_pence ?? row.commissionable_fare_pence ?? 0,
  );
  const pickupWaiting = Math.max(0, row.pickup_waiting_charge_pence ?? 0);
  const stopWaiting = Math.max(0, row.stop_waiting_charge_pence ?? 0);
  const tips = Math.max(0, row.tip_pence ?? row.tip_amount_pence ?? 0);
  const airport = Math.max(0, row.airport_charge_pence ?? 0);
  const passThrough = Math.max(0, row.other_pass_through_charges_pence ?? 0);
  return fare + pickupWaiting + stopWaiting + tips + airport + passThrough;
}

/** 1. Total customer revenue — payments primary, trips fallback. */
export function sumCustomerRevenuePence(args: {
  payments: PaymentCaptureRow[];
  trips: TripSSOTRow[];
}): { total_pence: number; source: "payments" | "trips_capture" | "trips_final_fare" } {
  const fromPayments = args.payments
    .filter((p) => CAPTURED_PAYMENT_STATUSES.has(String(p.status ?? "").toLowerCase()))
    .reduce((s, p) => s + Math.max(0, p.captured_amount_pence ?? 0), 0);

  if (fromPayments > 0) {
    return { total_pence: fromPayments, source: "payments" };
  }

  const fromCapture = args.trips.reduce((s, t) => s + Math.max(0, t.capture_amount_pence ?? 0), 0);
  if (fromCapture > 0) {
    return { total_pence: fromCapture, source: "trips_capture" };
  }

  const fromFinal = args.trips.reduce(
    (s, t) => s + Math.max(0, t.final_fare_pence ?? t.gross_fare_pence ?? 0),
    0,
  );
  return { total_pence: fromFinal, source: "trips_final_fare" };
}

/** 2. Refunded amount */
export function sumRefundedPence(rows: Array<{ refund_amount_pence?: number | null }>): number {
  return rows.reduce((s, r) => s + Math.max(0, r.refund_amount_pence ?? 0), 0);
}

/** 3. Net customer revenue */
export function netCustomerRevenuePence(total: number, refunded: number): number {
  return Math.max(0, total - refunded);
}

/** Cash trips — driver already collected fare physically; excluded from digital finance scope. */
export function isCashTripPaymentMethod(paymentMethod: string | null | undefined): boolean {
  return String(paymentMethod ?? "").trim().toLowerCase() === "cash";
}

export function isDigitalTripPaymentMethod(paymentMethod: string | null | undefined): boolean {
  return !isCashTripPaymentMethod(paymentMethod);
}

export function filterDigitalTrips<T extends { payment_method?: string | null }>(trips: T[]): T[] {
  return trips.filter((t) => isDigitalTripPaymentMethod(t.payment_method));
}

/** Digital customer revenue — captured payments on non-cash trips only. */
export function sumDigitalCustomerRevenuePence(args: {
  payments: PaymentCaptureRow[];
  digitalTripIds: Set<string>;
}): number {
  return args.payments
    .filter((p) => p.trip_id && args.digitalTripIds.has(p.trip_id))
    .filter((p) => CAPTURED_PAYMENT_STATUSES.has(String(p.status ?? "").toLowerCase()))
    .reduce((s, p) => s + Math.max(0, p.captured_amount_pence ?? 0), 0);
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

/** 5. ONECAB gross commission — trips.commission_pence only */
export function sumOnecabGrossCommissionPence(trips: TripSSOTRow[]): number {
  return trips.reduce((s, t) => s + Math.max(0, t.commission_pence ?? 0), 0);
}

/** 6. Provider processing fees — confirmed trip fees */
export function sumProviderProcessingFeesPence(trips: TripSSOTRow[]): number {
  return trips.reduce((s, t) => s + Math.max(0, t.stripe_processing_fee_pence ?? 0), 0);
}

/** 7. ONECAB net commission */
export function onecabNetCommissionPence(gross: number, providerFees: number): number {
  return Math.max(0, gross - providerFees);
}

/** 8. Driver net earnings */
export function sumDriverNetEarningsPence(trips: TripSSOTRow[]): number {
  return trips.reduce((s, t) => {
    if (t.driver_net_pence != null) return s + Math.max(0, t.driver_net_pence);
    const gross = tripDriverGrossEarningsPence(t);
    const commission = Math.max(0, t.commission_pence ?? 0);
    return s + Math.max(0, gross - commission);
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
 * @deprecated Phase 3A.4 — trip-based liability inflated cash-trip earnings.
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
 * Wallet ledger balance excluding PLATFORM_COMMISSION and CASH_TRIP_EARNING.
 * Payout / early-cashout debits are already netted in the ledger sum.
 */
export function perDriverLedgerLiabilityPence(ledger: LedgerSSOTRow[]): number {
  return Math.max(0, computeLedgerWalletBalancePence(ledger));
}

/** 11. Driver available now (platform — full provider balance cap). */
export function driverAvailableNowPence(args: {
  driverRemainingLiabilityPence: number;
  providerAvailableBalancePence: number;
}): number {
  return Math.min(
    Math.max(0, args.driverRemainingLiabilityPence),
    Math.max(0, args.providerAvailableBalancePence),
  );
}

/** Per-driver available now — allocated provider balance minus in-flight cashouts. */
export function perDriverAvailableNowPence(args: {
  driverRemainingLiabilityPence: number;
  providerAllocatedBalancePence: number;
  inFlightCashoutPence: number;
}): number {
  const capped = Math.min(
    Math.max(0, args.driverRemainingLiabilityPence),
    Math.max(0, args.providerAllocatedBalancePence),
  );
  return Math.max(0, capped - Math.max(0, args.inFlightCashoutPence));
}

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

/** 12. Driver pending payout */
export function driverPendingPayoutPence(args: {
  driverRemainingLiabilityPence: number;
  driverAvailableNowPence: number;
}): number {
  return Math.max(0, args.driverRemainingLiabilityPence - args.driverAvailableNowPence);
}

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
 * Cash-trip ONECAB commission is excluded from RHS. Cash fares are excluded from LHS.
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
 * Legacy all-trip ONECAB scope (includes cash-trip commission on RHS).
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
  const adjustmentsRhs = args.driverPaidOutPence > 0 ? args.adjustmentsPence : 0;
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
  customer_revenue_source: "payments" | "trips_capture" | "trips_final_fare";
  refunded_amount_pence: number;
  net_customer_revenue_pence: number;
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
};

export function computeSSOTMetrics(args: {
  payments: PaymentCaptureRow[];
  trips: TripSSOTRow[];
  ledger: LedgerSSOTRow[];
  providerAvailableBalancePence: number;
  providerPendingBalancePence: number;
}): SSOTComputedMetrics {
  const customerRev = sumCustomerRevenuePence({ payments: args.payments, trips: args.trips });
  const refunded = sumRefundedPence(args.trips);
  const netCustomer = netCustomerRevenuePence(customerRev.total_pence, refunded);
  const driverGross = sumDriverGrossEarningsPence(args.trips);
  const driverNet = sumDriverNetEarningsPence(args.trips);
  const onecabGross = sumOnecabGrossCommissionPence(args.trips);
  const providerFees = sumProviderProcessingFeesPence(args.trips);
  const onecabNet = onecabNetCommissionPence(onecabGross, providerFees);
  const paidOut = sumDriverPaidOutPence(args.ledger);
  const adjustments = sumAdjustmentsPence(args.ledger);
  const remaining = perDriverLedgerLiabilityPence(args.ledger);
  const availableNow = driverAvailableNowPence({
    driverRemainingLiabilityPence: remaining,
    providerAvailableBalancePence: args.providerAvailableBalancePence,
  });
  const pendingPayout = driverPendingPayoutPence({
    driverRemainingLiabilityPence: remaining,
    driverAvailableNowPence: availableNow,
  });

  return {
    total_customer_revenue_pence: customerRev.total_pence,
    customer_revenue_source: customerRev.source,
    refunded_amount_pence: refunded,
    net_customer_revenue_pence: netCustomer,
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
  };
}
