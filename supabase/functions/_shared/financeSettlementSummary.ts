/**
 * ONECAB commission vs driver payout visibility — shared types + helpers.
 *
 * CRITICAL: Financial Reconciliation SSOT owns all finance calculations.
 * See financialReconciliationSSOT.ts for canonical formulas.
 *
 * ONECAB gross commission = sum(trips.commission_pence) only.
 * Never use Stripe available balance, captured revenue, or driver payable as commission.
 */

import {
  buildReconciliationCheck,
  buildSplitReconciliationCheck,
  type FinanceDataSourceBadge,
  type SSOTComputedMetrics,
  SSOT_VERSION,
} from "./financialReconciliationSSOT.ts";
import {
  deriveTripFinancialAuditStatuses,
  type TripAuditLedgerRecord,
  type TripAuditPaymentRecord,
  type TripAuditPayoutRecord,
  type TripAuditStatusBadge,
} from "./tripFinancialAuditStatus.ts";
import {
  computeSettlementTotalPence,
  EXTRA_PAYMENT_TOLERANCE_PENCE,
} from "./extraPaymentRecoverySSOT.ts";
import {
  getPaymentRowCapturedPence,
  getTripCapturedPenceForAudit,
  getTripAvailablePayoutCreatedPence,
  getTripDebtRecoveredPence,
  getTripDriverNetPence,
  getTripSettlementFarePence,
  sumPaymentsCapturedPence,
} from "./tripSettlementFinanceSSOT.ts";

export { SSOT_VERSION, type FinanceDataSourceBadge };

export type OnecabSettlementStatus =
  | "calculated_only"
  | "pending_stripe_settlement"
  | "available_in_stripe_balance"
  | "paid_to_onecab_bank"
  | "reconciled";

export type TripFinanceRow = {
  commission_pence: number | null;
  stripe_processing_fee_pence: number | null;
  onecab_net_pence: number | null;
  driver_net_pence: number | null;
  gross_fare_pence: number | null;
  final_fare_pence: number | null;
  commissionable_fare_pence: number | null;
  capture_amount_pence: number | null;
  tip_pence: number | null;
  tip_amount_pence: number | null;
  payment_method: string | null;
  stripe_settlement_verified: boolean | null;
  driver_tier_commission_percent: number | null;
  commission_pct: number | null;
  completed_at: string | null;
};

export type PayoutFailureRow = {
  amount_pence: number | null;
  error_message: string | null;
  created_at: string | null;
};

const COUNTABLE_OUTCOMES = ["COMPLETED", "NO_SHOW", "LATE_PASSENGER_CANCELLATION"];
const DEFAULT_COMMISSION_RATE = 0.15;

export function commissionableRevenuePence(row: TripFinanceRow): number {
  return Math.max(
    0,
    row.commissionable_fare_pence ??
      row.final_fare_pence ??
      row.capture_amount_pence ??
      0,
  );
}

export function customerRevenuePence(row: TripFinanceRow): number {
  const tip = Math.max(0, row.tip_pence ?? row.tip_amount_pence ?? 0);
  const captured = row.capture_amount_pence ?? 0;
  if (captured > 0) return captured;
  return commissionableRevenuePence(row) + tip;
}

export function tripGrossCommissionPence(row: TripFinanceRow): number {
  return Math.max(0, row.commission_pence ?? 0);
}

export function isCashTripFinanceRow(row: TripFinanceRow): boolean {
  return String(row.payment_method ?? "").toUpperCase() === "CASH";
}

export function tripStripeFeePence(row: TripFinanceRow): number {
  if (isCashTripFinanceRow(row)) return 0;
  return Math.max(0, row.stripe_processing_fee_pence ?? 0);
}

export function tripOnecabNetPence(row: TripFinanceRow): number {
  if (isCashTripFinanceRow(row)) return tripGrossCommissionPence(row);
  if (row.onecab_net_pence != null) return Math.max(0, row.onecab_net_pence);
  return Math.max(0, tripGrossCommissionPence(row) - tripStripeFeePence(row));
}

/** Stored driver net only — never derives fare − commission. */
export function tripDriverNetPence(row: TripFinanceRow): number | null {
  if (row.driver_net_pence != null) return Math.max(0, row.driver_net_pence);
  return null;
}

/** Audit/display driver net — ledger TRIP_EARNING_NET first, then trips.driver_net_pence. */
export function tripDriverNetPenceForAudit(
  row: TripFinanceRow,
  ledger: TripAuditLedgerRecord[] = [],
): number | null {
  return getTripDriverNetPence({
    driver_net_pence: row.driver_net_pence,
    ledger,
  });
}

export function sumTripFinanceMetrics(rows: TripFinanceRow[]) {
  let totalCustomerRevenue = 0;
  let totalCommissionableRevenue = 0;
  let driverGrossEarnings = 0;
  let driverNetEarnings = 0;
  let grossCommission = 0;
  let stripeFees = 0;
  let onecabNet = 0;
  let verifiedOnecabNet = 0;
  let unverifiedOnecabNet = 0;
  let verifiedCount = 0;

  for (const row of rows) {
    const commissionable = commissionableRevenuePence(row);
    const customerRev = customerRevenuePence(row);
    const grossComm = tripGrossCommissionPence(row);
    const stripeFee = tripStripeFeePence(row);
    const net = tripOnecabNetPence(row);
    const driverNet = tripDriverNetPence(row) ?? 0;

    totalCustomerRevenue += customerRev;
    totalCommissionableRevenue += commissionable;
    driverGrossEarnings += commissionable;
    driverNetEarnings += driverNet;
    grossCommission += grossComm;
    stripeFees += stripeFee;
    onecabNet += net;

    if (row.stripe_settlement_verified === true) {
      verifiedOnecabNet += net;
      verifiedCount += 1;
    } else {
      unverifiedOnecabNet += net;
    }
  }

  const maxCommissionAtDefaultRate = Math.round(totalCommissionableRevenue * DEFAULT_COMMISSION_RATE);
  const commissionExceedsCap = grossCommission > maxCommissionAtDefaultRate + 5;

  return {
    tripCount: rows.length,
    total_customer_revenue_pence: totalCustomerRevenue,
    total_commissionable_revenue_pence: totalCommissionableRevenue,
    driver_gross_earnings_pence: driverGrossEarnings,
    driver_net_earnings_pence: driverNetEarnings,
    onecab_gross_commission_pence: grossCommission,
    stripe_fee_pence: stripeFees,
    onecab_net_pence: onecabNet,
    verified_onecab_net_pence: verifiedOnecabNet,
    unverified_onecab_net_pence: unverifiedOnecabNet,
    verified_trip_count: verifiedCount,
    max_commission_at_15_percent_pence: maxCommissionAtDefaultRate,
    commission_exceeds_15_percent_cap: commissionExceedsCap,
  };
}

/** @deprecated use sumTripFinanceMetrics */
export function sumTripCommissions(rows: TripFinanceRow[]) {
  const m = sumTripFinanceMetrics(rows);
  return {
    gross: m.onecab_gross_commission_pence,
    stripeFee: m.stripe_fee_pence,
    net: m.onecab_net_pence,
    verifiedNet: m.verified_onecab_net_pence,
    unverifiedNet: m.unverified_onecab_net_pence,
    verifiedCount: m.verified_trip_count,
    tripCount: m.tripCount,
  };
}

export function classifyOnecabSettlementStatus(args: {
  calculatedOnecabNetPence: number;
  verifiedOnecabNetPence: number;
  stripeAvailablePence: number;
  stripePendingPence: number;
  verifiedTripCount: number;
  tripCount: number;
}): OnecabSettlementStatus {
  const {
    calculatedOnecabNetPence,
    verifiedOnecabNetPence,
    stripeAvailablePence,
    stripePendingPence,
    verifiedTripCount,
    tripCount,
  } = args;

  if (calculatedOnecabNetPence <= 0) return "calculated_only";
  if (verifiedTripCount === 0) return "calculated_only";
  if (verifiedTripCount < tripCount || stripePendingPence > 0) {
    return "pending_stripe_settlement";
  }
  if (stripeAvailablePence >= verifiedOnecabNetPence && verifiedOnecabNetPence > 0) {
    return "available_in_stripe_balance";
  }
  if (stripePendingPence > 0) return "pending_stripe_settlement";
  return "calculated_only";
}

/**
 * Stripe cash partition — NOT ONECAB commission.
 * platform_cash_after_driver_liability = stripe available − driver payable − pending transfers
 */
export function partitionStripePlatformCash(args: {
  stripeAvailablePence: number;
  driverPayoutLiabilityPence: number;
  pendingTransfersPence: number;
}) {
  const allocatedToDrivers = args.driverPayoutLiabilityPence + args.pendingTransfersPence;
  const unallocatedPlatformCash = args.stripeAvailablePence - allocatedToDrivers;
  return {
    stripe_available_platform_balance_pence: args.stripeAvailablePence,
    driver_payout_liability_pence: args.driverPayoutLiabilityPence,
    pending_transfers_pence: args.pendingTransfersPence,
    unallocated_platform_cash_pence: unallocatedPlatformCash,
  };
}

export function reconcileStripeBalance(args: {
  stripeAvailablePence: number;
  calculatedOnecabNetPence: number;
  availableDriverPayablePence: number;
  pendingTransfersPence: number;
  tolerancePence?: number;
}) {
  const tolerance = args.tolerancePence ?? 100;
  const partition = partitionStripePlatformCash({
    stripeAvailablePence: args.stripeAvailablePence,
    driverPayoutLiabilityPence: args.availableDriverPayablePence,
    pendingTransfersPence: args.pendingTransfersPence,
  });

  const expectedCash =
    args.calculatedOnecabNetPence +
    args.availableDriverPayablePence +
    args.pendingTransfersPence;
  const reserves = args.stripeAvailablePence - expectedCash;
  const delta = Math.abs(reserves);
  const reconciles = delta <= tolerance;

  return {
    stripe_available_balance_pence: args.stripeAvailablePence,
    /** Trip-derived ONECAB net after Stripe fees — NOT (Stripe balance − driver payable) */
    calculated_onecab_net_pence: args.calculatedOnecabNetPence,
    available_driver_payable_pence: args.availableDriverPayablePence,
    pending_transfers_pence: args.pendingTransfersPence,
    unallocated_platform_cash_pence: partition.unallocated_platform_cash_pence,
    reserves_or_adjustments_pence: reserves,
    reconciles,
    mismatch_warning: reconciles
      ? null
      : "Stripe balance reconciliation mismatch.",
  };
}

export function parseInsufficientFundsReason(errorMessage: string | null): string | null {
  if (!errorMessage) return null;
  const lower = errorMessage.toLowerCase();
  if (lower.includes("insufficient") && (lower.includes("fund") || lower.includes("balance"))) {
    return "Stripe available balance was lower than requested driver payout.";
  }
  return null;
}

export function buildInsufficientFundsDiagnosis(args: {
  failureReason: string | null;
  requestedPayoutPence: number;
  stripeAvailablePence: number;
  stripePendingPence: number;
  calculatedOnecabNetPence: number;
  driverPendingSettlementPence: number;
}): string[] {
  const diagnoses: string[] = [];
  const insufficient = parseInsufficientFundsReason(args.failureReason);

  if (insufficient) diagnoses.push(insufficient);
  if (args.requestedPayoutPence > args.stripeAvailablePence) {
    diagnoses.push("Driver payout amount exceeded Stripe available balance.");
  }
  if (args.stripePendingPence > 0 && args.stripeAvailablePence < args.requestedPayoutPence) {
    diagnoses.push("Stripe funds are pending, not available.");
  }
  if (args.calculatedOnecabNetPence > 0 && args.stripeAvailablePence < args.requestedPayoutPence) {
    diagnoses.push("ONECAB commission was calculated on trips but Stripe available cash is lower than driver payout request.");
  }
  if (args.driverPendingSettlementPence > 0) {
    diagnoses.push("Driver funds are pending next payout cycle.");
  }
  if (diagnoses.length === 0 && args.failureReason) {
    diagnoses.push("Driver Connect transfer failed.");
  }
  return diagnoses;
}

export function computeSafePayoutAmount(args: {
  driverAvailablePence: number;
  stripeAvailablePence: number;
  minimumPayoutPence?: number;
}) {
  const min = args.minimumPayoutPence ?? 100;
  const capped = Math.min(Math.max(0, args.driverAvailablePence), Math.max(0, args.stripeAvailablePence));
  return {
    payout_amount_pence: capped,
    partial: capped < args.driverAvailablePence && capped > 0,
    blocked: capped < min,
    waiting_for_stripe_funds: args.stripeAvailablePence < args.driverAvailablePence,
  };
}

export const COUNTABLE_FINANCIAL_OUTCOMES = COUNTABLE_OUTCOMES;

/** SSOT finance reconciliation payload — all admin finance surfaces read from this shape. */
export type FinanceReconciliationSummary = {
  customer_revenue: {
    card_customer_revenue_pence: number;
    cash_collected_by_driver_pence: number;
    refunded_amount_pence: number;
    net_card_revenue_pence: number;
    /** @deprecated Use card_customer_revenue_pence + cash_collected_by_driver_pence */
    total_customer_revenue_pence: number;
    /** @deprecated Use net_card_revenue_pence for Stripe revenue */
    net_customer_revenue_pence: number;
    commissionable_revenue_pence: number;
  };
  driver_money: {
    card_driver_payable_pence: number;
    cash_driver_already_received_pence: number;
    driver_wallet_balance_pence: number;
    driver_available_payout_pence: number;
    driver_pending_payout_pence: number;
    driver_paid_out_pence: number;
    driver_payout_liability_pence: number;
    onecab_cash_commission_owed_pence: number;
    in_flight_cashout_pence: number;
    /** @deprecated Lifetime earnings — use Driver Earnings screen */
    driver_gross_earnings_pence?: number;
    /** @deprecated Mixed card+cash — use card_driver_payable_pence */
    driver_net_earnings_pence?: number;
  };
  onecab_money: {
    onecab_card_commission_pence: number;
    onecab_cash_commission_receivable_pence: number;
    onecab_gross_commission_pence: number;
    provider_processing_fee_pence: number;
    onecab_card_net_commission_pence: number;
    total_commission_earned_pence: number;
    net_platform_revenue_pence: number;
    /** Alias of net_platform_revenue_pence */
    onecab_net_commission_pence: number;
    onecab_bank_payout_pence: number;
    onecab_commission_status: OnecabSettlementStatus;
    onecab_commission_status_label: string;
  };
  provider_money: {
    provider_name: string;
    provider_available_balance_pence: number;
    provider_pending_balance_pence: number;
    provider_health_status: "healthy" | "degraded" | "failing" | "unknown";
    last_webhook_received_at: string | null;
  };
  reconciliation_check: {
    card_reconciliation: {
      card_customer_revenue_pence: number;
      card_driver_payable_pence: number;
      onecab_card_commission_pence: number;
      expected_sum_pence: number;
      variance_pence: number;
      delta_pence: number;
      balanced: boolean;
      status: "BALANCED" | "RECONCILIATION_MISMATCH";
    };
    cash_reconciliation: {
      cash_collected_by_driver_pence: number;
      cash_driver_already_received_pence: number;
      onecab_cash_commission_receivable_pence: number;
      expected_sum_pence: number;
      variance_pence: number;
      delta_pence: number;
      balanced: boolean;
      status: "BALANCED" | "RECONCILIATION_MISMATCH";
    };
    net_customer_revenue_pence: number;
    driver_paid_out_pence: number;
    driver_remaining_liability_pence: number;
    driver_net_earnings_pence: number;
    onecab_gross_commission_pence: number;
    onecab_net_commission_pence: number;
    provider_processing_fee_pence: number;
    adjustments_pence: number;
    expected_sum_pence: number;
    variance_pence: number;
    delta_pence: number;
    balanced: boolean;
    status: "BALANCED" | "RECONCILIATION_MISMATCH" | "balanced" | "reconciliation_error";
  };
  ssot?: {
    version: string;
    data_source_badge: FinanceDataSourceBadge;
    customer_revenue_source: string;
  };
  pending_stripe_confirmation?: {
    label: string;
    trip_count: number;
    expected_revenue_pence: number;
    expected_commission_pence: number;
    expected_driver_net_pence: number;
  };
  money_movement?: import("./connectMoneyMovementSSOT.ts").ConnectMoneyMovementBundle;
};

export type TripFinancialAuditRow = {
  trip_id: string;
  trip_code: string | null;
  date: string | null;
  driver_id: string | null;
  customer_name: string | null;
  driver_name: string | null;
  payment_method: string | null;
  stripe_payment_intent_id?: string | null;
  customer_paid_pence: number;
  /** Pre-discount gross fare from trip record (SSOT). */
  gross_fare_pence: number;
  /** max(0, gross_fare − final_fare) — backend only. */
  discount_pence: number;
  /** Fare after discount, before tip/extras. */
  final_fare_pence: number;
  /** Settlement total (fare + tip + fees) — same as customer_paid_pence for audit rows. */
  settlement_total_pence: number;
  captured_pence: number;
  refunded_pence: number;
  net_customer_payment_pence: number;
  /** Amount still owed when captured < settlement. */
  outstanding_pence: number;
  capture_mismatch: boolean;
  driver_net_pence: number | null;
  /** Cash commission debt recovered from card earnings on this trip. */
  debt_recovered_pence: number;
  /** driver_net − debt_recovered — amount added to available payout liability. */
  available_payout_created_pence: number | null;
  onecab_gross_commission_pence: number;
  processing_fee_pence: number;
  onecab_net_pence: number;
  driver_payout: TripAuditStatusBadge;
  onecab_commission: TripAuditStatusBadge;
  provider: TripAuditStatusBadge;
  /** @deprecated Use driver_payout.label */
  driver_payout_status?: string;
  /** @deprecated Use onecab_commission.label */
  onecab_commission_status?: string;
  /** @deprecated Use provider.label */
  provider_status?: string;
  trip_status?: string | null;
  financial_outcome?: string | null;
  currency_code?: string | null;
};

export type TripAuditSourceRow = TripFinanceRow & {
  id: string;
  trip_code?: string | null;
  status?: string | null;
  refund_amount_pence?: number | null;
  outstanding_balance_pence?: number | null;
  payment_coverage_status?: string | null;
  airport_charge_pence?: number | null;
  other_pass_through_charges_pence?: number | null;
  payment_status?: string | null;
  financial_outcome?: string | null;
  stripe_payment_intent_id?: string | null;
  stripe_charge_id?: string | null;
  provider_status?: string | null;
  driver_id?: string | null;
  passenger_name?: string | null;
  service_area_id?: string | null;
  driver?: { first_name?: string | null; last_name?: string | null } | null;
};

export type TripFinancialAuditContext = {
  paymentByTripId: Map<string, TripAuditPaymentRecord>;
  paymentsByTripId: Map<string, TripAuditPaymentRecord[]>;
  payoutsByTripId: Map<string, TripAuditPayoutRecord[]>;
  ledgerByTripId: Map<string, TripAuditLedgerRecord[]>;
  currencyCodeByServiceAreaId?: Map<string, string>;
  defaultCurrencyCode?: string | null;
};

export function sumRefundedAmountPence(rows: Array<{ refund_amount_pence?: number | null }>): number {
  return rows.reduce((s, r) => s + Math.max(0, r.refund_amount_pence ?? 0), 0);
}

export function commissionableRevenueFromCaptured(args: {
  capturedPence: number;
  tipPence: number;
  airportPence: number;
  passThroughPence: number;
  refundedPence: number;
}): number {
  return Math.max(
    0,
    args.capturedPence - args.tipPence - args.airportPence - args.passThroughPence - args.refundedPence,
  );
}

/** Assemble SSOT reconciliation payload from canonical metrics. */
export function buildFinanceReconciliationSummary(args: {
  ssot: SSOTComputedMetrics;
  commissionableRevenuePence: number;
  driverWalletBalancePence: number;
  inFlightCashoutPence: number;
  settlementStatus: OnecabSettlementStatus;
  settlementStatusLabel: string;
  providerHealthStatus: FinanceReconciliationSummary["provider_money"]["provider_health_status"];
  lastWebhookReceivedAt: string | null;
  onecabBankPayoutPence?: number;
  tolerancePence?: number;
  dataSourceBadge?: FinanceDataSourceBadge;
  /** When true, BALANCED status uses trip-earnings split (correct for date-filtered reports). */
  periodScoped?: boolean;
  moneyMovement?: import("./connectMoneyMovementSSOT.ts").ConnectMoneyMovementBundle;
}): FinanceReconciliationSummary {
  const m = args.ssot;
  const driverAvailablePayout = Math.max(0, m.driver_available_now_pence - args.inFlightCashoutPence);

  const split = m.ledger_split;
  const splitReconciliation = buildSplitReconciliationCheck({
    ledger: split,
    tolerancePence: args.tolerancePence,
  });

  return {
    customer_revenue: {
      card_customer_revenue_pence: split.card_customer_revenue_pence,
      cash_collected_by_driver_pence: split.cash_collected_by_driver_pence,
      refunded_amount_pence: m.refunded_amount_pence,
      net_card_revenue_pence: split.net_card_revenue_pence,
      total_customer_revenue_pence: split.card_customer_revenue_pence + split.cash_collected_by_driver_pence,
      net_customer_revenue_pence: split.net_card_revenue_pence,
      commissionable_revenue_pence: args.commissionableRevenuePence,
    },
    driver_money: {
      card_driver_payable_pence: split.card_driver_payable_pence,
      cash_driver_already_received_pence: split.cash_driver_already_received_pence,
      driver_wallet_balance_pence: args.driverWalletBalancePence,
      driver_available_payout_pence: driverAvailablePayout,
      driver_pending_payout_pence: m.driver_pending_payout_pence,
      driver_paid_out_pence: m.driver_paid_out_pence,
      driver_payout_liability_pence: m.driver_remaining_liability_pence,
      onecab_cash_commission_owed_pence: split.onecab_cash_commission_receivable_pence,
      in_flight_cashout_pence: args.inFlightCashoutPence,
      driver_gross_earnings_pence: m.driver_gross_earnings_pence,
      driver_net_earnings_pence: m.driver_net_earnings_pence,
    },
    onecab_money: {
      onecab_card_commission_pence: split.onecab_card_commission_pence,
      onecab_cash_commission_receivable_pence: split.onecab_cash_commission_receivable_pence,
      onecab_gross_commission_pence: m.onecab_gross_commission_pence,
      provider_processing_fee_pence: m.provider_processing_fee_pence,
      onecab_card_net_commission_pence: m.onecab_card_net_commission_pence,
      total_commission_earned_pence: m.total_commission_earned_pence,
      net_platform_revenue_pence: m.net_platform_revenue_pence,
      onecab_net_commission_pence: m.net_platform_revenue_pence,
      onecab_bank_payout_pence: args.onecabBankPayoutPence ?? 0,
      onecab_commission_status: args.settlementStatus,
      onecab_commission_status_label: args.settlementStatusLabel,
    },
    provider_money: {
      provider_name: "Stripe",
      provider_available_balance_pence: m.provider_available_balance_pence,
      provider_pending_balance_pence: m.provider_pending_balance_pence,
      provider_health_status: args.providerHealthStatus,
      last_webhook_received_at: args.lastWebhookReceivedAt,
    },
    reconciliation_check: {
      card_reconciliation: splitReconciliation.card_reconciliation,
      cash_reconciliation: splitReconciliation.cash_reconciliation,
      net_customer_revenue_pence: split.card_customer_revenue_pence,
      driver_paid_out_pence: m.driver_paid_out_pence,
      driver_remaining_liability_pence: m.driver_remaining_liability_pence,
      driver_net_earnings_pence: split.card_driver_payable_pence,
      onecab_gross_commission_pence: m.total_commission_earned_pence,
      onecab_net_commission_pence: m.net_platform_revenue_pence,
      provider_processing_fee_pence: m.provider_processing_fee_pence,
      adjustments_pence: m.adjustments_pence,
      expected_sum_pence: splitReconciliation.card_reconciliation.expected_sum_pence,
      variance_pence: Math.max(
        Math.abs(splitReconciliation.card_reconciliation.variance_pence),
        Math.abs(splitReconciliation.cash_reconciliation.variance_pence),
      ),
      delta_pence: Math.max(
        Math.abs(splitReconciliation.card_reconciliation.delta_pence),
        Math.abs(splitReconciliation.cash_reconciliation.delta_pence),
      ),
      balanced: splitReconciliation.balanced,
      status: splitReconciliation.status,
    },
    ssot: {
      version: SSOT_VERSION,
      data_source_badge: args.dataSourceBadge ?? "LIVE",
      customer_revenue_source: formatCustomerRevenueSourceLabel(m.customer_revenue_source),
    },
    pending_stripe_confirmation: m.pending_trip_count > 0
      ? {
        label: "Expected / Pending Stripe confirmation",
        trip_count: m.pending_trip_count,
        expected_revenue_pence: m.pending_stripe_confirmation_revenue_pence,
        expected_commission_pence: m.pending_stripe_confirmation_commission_pence,
        expected_driver_net_pence: m.pending_stripe_confirmation_driver_net_pence,
      }
      : undefined,
    money_movement: args.moneyMovement,
  };
}

function formatCustomerRevenueSourceLabel(
  source: import("./financialReconciliationSSOT.ts").CustomerRevenueSourceLabel,
): string {
  switch (source) {
    case "payments_captured":
      return "Reconciled — captured payments only";
    case "expected_pending_stripe_confirmation":
      return "Expected / Pending Stripe confirmation";
    case "trips_capture_fallback_pending":
      return "Expected / Pending Stripe confirmation (trip capture fallback)";
    case "trips_final_fare_fallback_pending":
      return "Expected / Pending Stripe confirmation (trip fare fallback)";
    default:
      return String(source);
  }
}

export function computeAuditCaptureMismatch(args: {
  payment_method: string | null;
  settlement_pence: number;
  captured_pence: number;
  outstanding_balance_pence?: number | null;
  payment_coverage_status?: string | null;
}): boolean {
  if ((args.payment_method ?? "").toLowerCase() === "cash") return false;
  if ((args.payment_coverage_status ?? "").toLowerCase() === "captured") return false;
  const outstanding = computeAuditOutstandingPence({
    settlement_pence: args.settlement_pence,
    captured_pence: args.captured_pence,
    outstanding_balance_pence: args.outstanding_balance_pence,
  });
  return outstanding > EXTRA_PAYMENT_TOLERANCE_PENCE;
}

export function computeAuditOutstandingPence(args: {
  settlement_pence: number;
  captured_pence: number;
  outstanding_balance_pence?: number | null;
}): number {
  const computed = Math.max(0, args.settlement_pence - args.captured_pence);
  const stored = Math.max(0, args.outstanding_balance_pence ?? 0);

  if (args.captured_pence >= args.settlement_pence - EXTRA_PAYMENT_TOLERANCE_PENCE) {
    return 0;
  }
  if (stored === 0 && computed <= EXTRA_PAYMENT_TOLERANCE_PENCE) {
    return 0;
  }
  if (
    stored > 0 &&
    Math.abs(stored - computed) <= EXTRA_PAYMENT_TOLERANCE_PENCE
  ) {
    return stored;
  }
  return computed > 0 ? computed : stored;
}

export function mapTripToFinancialAuditRow(
  row: TripAuditSourceRow,
  context: TripFinancialAuditContext = {
    paymentByTripId: new Map(),
    paymentsByTripId: new Map(),
    payoutsByTripId: new Map(),
    ledgerByTripId: new Map(),
  },
): TripFinancialAuditRow {
  const payment = context.paymentByTripId.get(row.id) ?? null;
  const tripPayments = context.paymentsByTripId.get(row.id) ?? [];
  const ledger = context.ledgerByTripId.get(row.id) ?? [];
  const paymentCaptured = payment ? getPaymentRowCapturedPence(payment) : 0;
  const capturedFromAllPayments = sumPaymentsCapturedPence(tripPayments);
  const captured = capturedFromAllPayments > 0
    ? capturedFromAllPayments
    : getTripCapturedPenceForAudit({
      paymentCapturedPence: paymentCaptured > 0 ? paymentCaptured : null,
      tripCaptureAmountPence: row.capture_amount_pence,
    });
  const refunded = Math.max(0, row.refund_amount_pence ?? 0);
  const settlementTotal = computeSettlementTotalPence(row);
  const customerPaid = settlementTotal;
  const grossFarePence = Math.max(0, Number(row.gross_fare_pence ?? row.commissionable_fare_pence ?? 0));
  const finalFarePence = Math.max(0, Number(row.final_fare_pence ?? 0));
  const discountPence = Math.max(0, grossFarePence - finalFarePence);
  const driverName = row.driver
    ? [row.driver.first_name, row.driver.last_name].filter(Boolean).join(" ").trim() || null
    : null;

  const statuses = deriveTripFinancialAuditStatuses({
    trip: row,
    payment,
    payouts: context.payoutsByTripId.get(row.id) ?? [],
    ledger,
  });

  const outstanding = computeAuditOutstandingPence({
    settlement_pence: settlementTotal,
    captured_pence: captured,
    outstanding_balance_pence: row.outstanding_balance_pence,
  });
  const captureMismatch = computeAuditCaptureMismatch({
    payment_method: row.payment_method ?? null,
    settlement_pence: settlementTotal,
    captured_pence: captured,
    outstanding_balance_pence: row.outstanding_balance_pence,
    payment_coverage_status: row.payment_coverage_status ?? null,
  });

  const driverNet = tripDriverNetPenceForAudit(row, ledger);
  const debtRecovered = getTripDebtRecoveredPence(ledger);
  const availablePayoutCreated = getTripAvailablePayoutCreatedPence({
    driverNetPence: driverNet,
    debtRecoveredPence: debtRecovered,
  });

  const paymentIntentId =
    row.stripe_payment_intent_id ??
    payment?.stripe_payment_intent_id ??
    tripPayments.find((p) => p.stripe_payment_intent_id)?.stripe_payment_intent_id ??
    null;

  return {
    trip_id: row.id,
    trip_code: row.trip_code ?? null,
    date: row.completed_at ?? null,
    driver_id: row.driver_id ?? null,
    customer_name: row.passenger_name?.trim() || null,
    driver_name: driverName,
    payment_method: row.payment_method ?? null,
    stripe_payment_intent_id: paymentIntentId,
    customer_paid_pence: customerPaid,
    gross_fare_pence: grossFarePence,
    discount_pence: discountPence,
    final_fare_pence: finalFarePence,
    settlement_total_pence: settlementTotal,
    captured_pence: captured,
    refunded_pence: refunded,
    net_customer_payment_pence: Math.max(0, customerPaid - refunded),
    outstanding_pence: outstanding,
    capture_mismatch: captureMismatch,
    driver_net_pence: driverNet,
    debt_recovered_pence: debtRecovered,
    available_payout_created_pence: availablePayoutCreated,
    onecab_gross_commission_pence: tripGrossCommissionPence(row),
    processing_fee_pence: tripStripeFeePence(row),
    onecab_net_pence: tripOnecabNetPence(row),
    driver_payout: statuses.driver_payout,
    onecab_commission: statuses.onecab_commission,
    provider: statuses.provider,
    /** @deprecated Legacy string fields — kept for older admin clients */
    driver_payout_status: statuses.driver_payout.label,
    onecab_commission_status: statuses.onecab_commission.label,
    provider_status: statuses.provider.label,
    trip_status: row.status ?? null,
    financial_outcome: row.financial_outcome ?? null,
    currency_code: row.service_area_id && context.currencyCodeByServiceAreaId
      ? (context.currencyCodeByServiceAreaId.get(row.service_area_id) ?? context.defaultCurrencyCode ?? null)
      : (context.defaultCurrencyCode ?? null),
  };
}

export function buildTripFinancialAuditContext(args: {
  payments: Array<{
    trip_id: string | null;
    status: string | null;
    provider_status: string | null;
    captured_amount_pence: number | null;
    stripe_payment_intent_id?: string | null;
    provider_available_on?: string | null;
  }>;
  payoutItems: Array<{
    trip_id: string | null;
    status: string;
    driver_amount_pence?: number | null;
    amount_pence?: number | null;
    batch_id?: string | null;
    batch?: { status?: string | null } | null;
  }>;
  ledgerRows: Array<{
    related_trip_id: string | null;
    type: string;
    amount_pence: number;
    stripe_payout_id?: string | null;
    stripe_transfer_id?: string | null;
  }>;
  currencyCodeByServiceAreaId?: Map<string, string>;
  defaultCurrencyCode?: string | null;
}): TripFinancialAuditContext {
  const paymentByTripId = new Map<string, TripAuditPaymentRecord>();
  const paymentsByTripId = new Map<string, TripAuditPaymentRecord[]>();
  for (const p of args.payments) {
    if (!p.trip_id) continue;
    const record: TripAuditPaymentRecord = {
      status: p.status,
      provider_status: p.provider_status,
      captured_amount_pence: p.captured_amount_pence,
      stripe_payment_intent_id: p.stripe_payment_intent_id ?? null,
      provider_available_on: p.provider_available_on ?? null,
    };
    const list = paymentsByTripId.get(p.trip_id) ?? [];
    list.push(record);
    paymentsByTripId.set(p.trip_id, list);

    const existing = paymentByTripId.get(p.trip_id);
    const existingCap = Math.max(0, existing?.captured_amount_pence ?? 0);
    const newCap = Math.max(0, record.captured_amount_pence ?? 0);
    if (!existing || newCap >= existingCap) {
      paymentByTripId.set(p.trip_id, record);
    }
  }

  const payoutsByTripId = new Map<string, TripAuditPayoutRecord[]>();
  for (const item of args.payoutItems) {
    if (!item.trip_id) continue;
    const list = payoutsByTripId.get(item.trip_id) ?? [];
    list.push({
      status: item.status,
      driver_amount_pence: item.driver_amount_pence,
      amount_pence: item.amount_pence,
      batch_status: item.batch?.status ?? null,
      batch_id: item.batch_id ?? null,
    });
    payoutsByTripId.set(item.trip_id, list);
  }

  const ledgerByTripId = new Map<string, TripAuditLedgerRecord[]>();
  for (const entry of args.ledgerRows) {
    if (!entry.related_trip_id) continue;
    const list = ledgerByTripId.get(entry.related_trip_id) ?? [];
    list.push({
      type: entry.type,
      amount_pence: entry.amount_pence,
      stripe_payout_id: entry.stripe_payout_id ?? null,
      stripe_transfer_id: entry.stripe_transfer_id ?? null,
    });
    ledgerByTripId.set(entry.related_trip_id, list);
  }

  return {
    paymentByTripId,
    paymentsByTripId,
    payoutsByTripId,
    ledgerByTripId,
    currencyCodeByServiceAreaId: args.currencyCodeByServiceAreaId,
    defaultCurrencyCode: args.defaultCurrencyCode ?? null,
  };
}

export function sumCommissionableFromTrips(rows: TripAuditSourceRow[]): number {
  let total = 0;
  for (const row of rows) {
    const captured = Math.max(0, row.capture_amount_pence ?? 0);
    const tip = Math.max(0, row.tip_pence ?? row.tip_amount_pence ?? 0);
    const airport = Math.max(0, row.airport_charge_pence ?? 0);
    const passThrough = Math.max(0, row.other_pass_through_charges_pence ?? 0);
    const refunded = Math.max(0, row.refund_amount_pence ?? 0);
    if (captured > 0) {
      total += commissionableRevenueFromCaptured({
        capturedPence: captured,
        tipPence: tip,
        airportPence: airport,
        passThroughPence: passThrough,
        refundedPence: refunded,
      });
    } else {
      total += commissionableRevenuePence(row);
    }
  }
  return total;
}
