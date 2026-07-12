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
  buildPaymentSessionMoneyByTrip,
  buildReconciliationCheck,
  buildSplitReconciliationCheck,
  confirmedCapturePence,
  type FinanceDataSourceBadge,
  type PaymentSessionMoneyRow,
  type SSOTComputedMetrics,
  SSOT_VERSION,
} from "./financialReconciliationSSOT.ts";
import {
  classifyPayoutReconciliation,
  classifyProviderVerificationStatus,
  classifyRefundReconciliation,
  classifyReleaseReconciliation,
  classifyWalletReconciliation,
  evaluateSettlementCaptureIdentity,
  onecabNetFromSessionFee,
  resolveFrTripAuditStatus,
  sumTripWalletEarningCreditPence,
} from "./frTripAuditComparisonSSOT.ts";
import {
  captureClassificationToMatchStatus,
  readPersistedCaptureBreakdown,
  type PaymentSessionCaptureBreakdown,
} from "../../../shared/paymentSessionsCaptureBreakdownSSOT.ts";
import {
  deriveTripFinancialAuditStatuses,
  deriveTripReconciliationBadge,
  deriveTripCaptureStatusLabel,
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
  getTripAvailablePayoutCreatedPence,
  getTripDebtRecoveredPence,
  getTripDriverNetPence,
  getTripSettlementFarePence,
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
  provider_fee_pence?: number | null;
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
  const method = String(row.payment_method ?? "").toLowerCase();
  const isCash = method === "cash" || method.includes("cash");

  // Cash: customer paid the fare (no Payment Session capture).
  if (isCash) return commissionableRevenuePence(row) + tip;

  // Digital/card: Payment Sessions owns capture — never invent from trips.capture_amount_pence.
  return 0;
}

export function tripGrossCommissionPence(row: TripFinanceRow): number {
  return Math.max(0, row.commission_pence ?? 0);
}


export function tripStripeFeePence(row: TripFinanceRow): number {
  return Math.max(0, row.stripe_processing_fee_pence ?? 0);
}

export function tripOnecabNetPence(row: TripFinanceRow): number | null {
  // Consume stored net only — never invent gross − fee when unknown.
  if (row.onecab_net_pence != null) return Math.max(0, row.onecab_net_pence);
  return null;
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
    if (net != null) onecabNet += net;

    if (row.stripe_settlement_verified === true) {
      if (net != null) verifiedOnecabNet += net;
      verifiedCount += 1;
    } else if (net != null) {
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
    refunded_amount_pence: number;
    net_card_revenue_pence: number;
    /** @deprecated Use card_customer_revenue_pence */
    total_customer_revenue_pence: number;
    /** @deprecated Use net_card_revenue_pence for Stripe revenue */
    net_customer_revenue_pence: number;
    commissionable_revenue_pence: number;
  };
  driver_money: {
    card_driver_payable_pence: number;
    driver_wallet_balance_pence: number;
    driver_available_payout_pence: number;
    driver_pending_payout_pence: number;
    driver_paid_out_pence: number;
    driver_payout_liability_pence: number;
    in_flight_cashout_pence: number;
    /** @deprecated Lifetime earnings — use Driver Earnings screen */
    driver_gross_earnings_pence?: number;
    /** @deprecated use card_driver_payable_pence */
    driver_net_earnings_pence?: number;
  };
  onecab_money: {
    onecab_card_commission_pence: number;
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
  /** Payment Sessions SSOT id when linked — navigation only. */
  payment_session_id?: string | null;
  /**
   * Digital: confirmed Payment Sessions capture only (null when unknown — never invent £0).
   * Cash: settlement total from trip snapshot.
   */
  customer_paid_pence: number | null;
  /** Pre-discount gross fare from trip record (SSOT). */
  gross_fare_pence: number;
  /** max(0, gross_fare − final_fare) — backend only. */
  discount_pence: number;
  /** Fare after discount, before tip/extras. */
  final_fare_pence: number;
  /** Canonical final customer fare (alias of final_fare_pence for FR DTO contract). */
  final_customer_fare_pence?: number | null;
  /** Settlement total (fare + tip + fees) — same as customer_paid_pence for audit rows. */
  settlement_total_pence: number;
  /** Confirmed capture from Payment Sessions — null when unconfirmed (never invent £0). */
  captured_pence: number | null;
  /** Cumulative refund from Payment Sessions — null when evidence unavailable. */
  refunded_pence: number | null;
  /** Capture − refund; null when capture unknown (never invent £0). */
  net_customer_payment_pence: number | null;
  service_area_id?: string | null;
  provider_state?: string | null;
  provider_verified_at?: string | null;
  provider_verification_status?: "VERIFIED" | "STALE" | "UNKNOWN" | null;
  release_reconciliation_status?: string | null;
  refund_reconciliation_status?: string | null;
  warnings?: string[];
  /** Amount still owed when captured < settlement. */
  outstanding_pence: number;
  capture_mismatch: boolean;
  driver_net_pence: number | null;
  /** Cash commission debt recovered from card earnings on this trip. */
  debt_recovered_pence: number;
  /** driver_net − debt_recovered — amount added to available payout liability. */
  available_payout_created_pence: number | null;
  onecab_gross_commission_pence: number;
  processing_fee_pence: number | null;
  /** Gross commission − PS provider fee; null when fee pending under sessions map. */
  onecab_net_pence: number | null;
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
  created_at?: string | null;
  payment_status?: string | null;
  capture_status?: string | null;
  reconciliation_status?: TripAuditStatusBadge;
  /** Ride fare (commissionable base) — backend SSOT. */
  ride_fare_pence?: number | null;
  airport_charge_pence?: number | null;
  tip_pence?: number | null;
  /** Pre-capture authorisation / hold amount when known. */
  authorised_pence?: number | null;
  /** Released hold amount when known (null = unconfirmed). */
  released_pence?: number | null;
  fee_status?: "PENDING_PROVIDER_FEE" | "CONFIRMED" | null;
  /** Alias of available_payout_created_pence for wallet-credit comparison. */
  wallet_credit_pence?: number | null;
  /** Customer payable − captured (null when either side unknown). */
  variance_pence?: number | null;
  /** Capture variance = captured − final_customer_fare (null when unknown). */
  capture_variance_pence?: number | null;
  /** Wallet credit − driver net (null when either side unknown). */
  wallet_variance_pence?: number | null;
  payout_variance_pence?: number | null;
  payout_amount_pence?: number | null;
  capture_reconciliation_status?: string | null;
  wallet_reconciliation_status?: string | null;
  payout_reconciliation_status?: string | null;
  wallet_status?: string | null;
  /** Payment evidence availability for digital trips. */
  payment_evidence_status?:
    | "PAYMENT_SESSIONS"
    | "NO_PAYMENT_SESSION"
    | "PAYMENT_EVIDENCE_UNAVAILABLE"
    | "CASH"
    | null;
  settlement_formula_version?: string | null;
  /** From Payment Sessions capture breakdown SSOT — FR consume-only. */
  variance_reason?: string | null;
  capture_classification?: string | null;
  ps_expected_capture_pence?: number | null;
  /** PS capture component — never FR-invented. */
  pickup_waiting_charge_pence?: number | null;
  stop_waiting_charge_pence?: number | null;
  capture_breakdown?: {
    ride_fare_pence: number | null;
    pickup_waiting_charge_pence: number | null;
    stop_waiting_charge_pence: number | null;
    expected_capture_pence: number | null;
    provider_captured_pence: number | null;
    variance_pence: number | null;
    variance_reason: string | null;
    capture_classification: string;
  } | null;
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
  pickup_waiting_charge_pence?: number | null;
  stop_waiting_charge_pence?: number | null;
  stop_charge_total_pence?: number | null;
  no_show_charge_pence?: number | null;
  customer_modification_charge_pence?: number | null;
  destination_change_adjustment_pence?: number | null;
  extras_pence?: number | null;
  final_customer_fare_pence?: number | null;
  payment_status?: string | null;
  financial_outcome?: string | null;
  stripe_payment_intent_id?: string | null;
  stripe_charge_id?: string | null;
  provider_status?: string | null;
  driver_id?: string | null;
  passenger_name?: string | null;
  service_area_id?: string | null;
  created_at?: string | null;
  driver?: { first_name?: string | null; last_name?: string | null } | null;
};

export type TripFinancialAuditContext = {
  paymentByTripId: Map<string, TripAuditPaymentRecord>;
  paymentsByTripId: Map<string, TripAuditPaymentRecord[]>;
  payoutsByTripId: Map<string, TripAuditPayoutRecord[]>;
  ledgerByTripId: Map<string, TripAuditLedgerRecord[]>;
  /** Payment Sessions money SSOT — preferred for customer capture/auth/release/refund/fee. */
  paymentSessionByTripId?: Map<string, import("./financialReconciliationSSOT.ts").PaymentSessionMoneyByTrip>;
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
  /** @deprecated Slice 4 / v2 — pass-through is commissionable; ignored. */
  passThroughPence?: number;
  refundedPence: number;
}): number {
  // v2: do not strip pass-through — commissionable = capture − tip − airport − refund.
  return Math.max(
    0,
    args.capturedPence - args.tipPence - args.airportPence - args.refundedPence,
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
      refunded_amount_pence: m.refunded_amount_pence,
      net_card_revenue_pence: split.net_card_revenue_pence,
      total_customer_revenue_pence: split.card_customer_revenue_pence,
      net_customer_revenue_pence: split.net_card_revenue_pence,
      commissionable_revenue_pence: args.commissionableRevenuePence,
    },
    driver_money: {
      card_driver_payable_pence: split.card_driver_payable_pence,
      driver_wallet_balance_pence: args.driverWalletBalancePence,
      driver_available_payout_pence: driverAvailablePayout,
      driver_pending_payout_pence: m.driver_pending_payout_pence,
      driver_paid_out_pence: m.driver_paid_out_pence,
      driver_payout_liability_pence: m.driver_remaining_liability_pence,
      in_flight_cashout_pence: args.inFlightCashoutPence,
      driver_gross_earnings_pence: m.driver_gross_earnings_pence,
      driver_net_earnings_pence: m.driver_net_earnings_pence,
    },
    onecab_money: {
      onecab_card_commission_pence: split.onecab_card_commission_pence,
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
      net_customer_revenue_pence: split.card_customer_revenue_pence,
      driver_paid_out_pence: m.driver_paid_out_pence,
      driver_remaining_liability_pence: m.driver_remaining_liability_pence,
      driver_net_earnings_pence: split.card_driver_payable_pence,
      onecab_gross_commission_pence: m.total_commission_earned_pence,
      onecab_net_commission_pence: m.net_platform_revenue_pence,
      provider_processing_fee_pence: m.provider_processing_fee_pence,
      adjustments_pence: m.adjustments_pence,
      expected_sum_pence: splitReconciliation.card_reconciliation.expected_sum_pence,
      variance_pence: Math.abs(splitReconciliation.card_reconciliation.variance_pence),
      delta_pence: Math.abs(splitReconciliation.card_reconciliation.delta_pence),
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
    case "payment_sessions_captured":
      return "Reconciled — Payment Sessions captures only";
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
  const sessionsMapPresent = context.paymentSessionByTripId != null;
  const session = context.paymentSessionByTripId?.get(row.id) ?? null;

  // Hard ownership: customer capture ONLY from Payment Sessions.
  // Never invent from legacy payments or trips.capture_amount_pence.
  const captured = session?.captured_amount_pence != null && session.captured_amount_pence > 0
    ? session.captured_amount_pence
    : null;

  const method = String(row.payment_method ?? "").toLowerCase();
  const isCash = method === "cash" || method.includes("cash");
  const payment_evidence_status = isCash
    ? "CASH" as const
    : !sessionsMapPresent
    ? "PAYMENT_EVIDENCE_UNAVAILABLE" as const
    : session == null
    ? "NO_PAYMENT_SESSION" as const
    : "PAYMENT_SESSIONS" as const;

  // Refunds: Payment Sessions only — never trip fallback invent; NULL ≠ £0.
  const refunded = !sessionsMapPresent || session == null
    ? null
    : (session.refunded_amount_pence == null
      ? null
      : Math.max(0, Number(session.refunded_amount_pence)));
  const settlementTotal = computeSettlementTotalPence(row);
  // Digital customer paid = confirmed PS capture only. Never invent £0 from missing evidence.
  const customerPaid = isCash
    ? settlementTotal
    : (captured != null ? captured : null);
  const grossFarePence = Math.max(0, Number(row.gross_fare_pence ?? row.commissionable_fare_pence ?? 0));
  const finalFarePence = Math.max(0, Number(row.final_fare_pence ?? 0));
  const discountPence = Math.max(0, grossFarePence - finalFarePence);
  const driverName = row.driver
    ? [row.driver.first_name, row.driver.last_name].filter(Boolean).join(" ").trim() || null
    : null;

  // Badge derivation may see PS capture via payment.captured — never trip invent.
  const paymentForStatus = {
    status: payment?.status ?? session?.status ?? null,
    provider_status: payment?.provider_status ?? null,
    captured_amount_pence: captured,
    stripe_payment_intent_id: payment?.stripe_payment_intent_id ?? null,
    provider_available_on: payment?.provider_available_on ?? null,
  };

  const statuses = deriveTripFinancialAuditStatuses({
    trip: row,
    payment: paymentForStatus,
    payouts: context.payoutsByTripId.get(row.id) ?? [],
    ledger,
  });

  const statusInput = {
    trip: row,
    payment: paymentForStatus,
    payouts: context.payoutsByTripId.get(row.id) ?? [],
    ledger,
  };

  // Outstanding only when capture known — do not invent £0 as confirmed capture for GREEN.
  const outstanding = captured == null
    ? Math.max(0, row.outstanding_balance_pence ?? settlementTotal)
    : computeAuditOutstandingPence({
      settlement_pence: settlementTotal,
      captured_pence: captured,
      outstanding_balance_pence: row.outstanding_balance_pence,
    });

  // Expected driver net = trip settlement snapshot. Actual wallet = ledger TRIP_EARNING_NET.
  const expectedDriverNet = tripDriverNetPence(row);
  const walletEarning = sumTripWalletEarningCreditPence(ledger);
  const walletCredit = walletEarning.credit_pence;
  const debtRecovered = getTripDebtRecoveredPence(ledger);
  const availablePayoutCreated = getTripAvailablePayoutCreatedPence({
    driverNetPence: expectedDriverNet,
    debtRecoveredPence: debtRecovered,
  });

  const paymentIntentId =
    row.stripe_payment_intent_id ??
    payment?.stripe_payment_intent_id ??
    tripPayments.find((p) => p.stripe_payment_intent_id)?.stripe_payment_intent_id ??
    null;

  // Provider fee: Payment Sessions only — never trip fee invent.
  const sessionFee = session?.provider_processing_fee_pence;
  const processingFeePence = sessionsMapPresent
    ? (sessionFee == null ? null : Math.max(0, Number(sessionFee)))
    : null;
  const sessionFeeStatusRaw = String(session?.fee_status ?? "").toUpperCase();
  const fee_status = !sessionsMapPresent || session == null
    ? null
    : (processingFeePence == null
      || sessionFeeStatusRaw === "PENDING"
      || sessionFeeStatusRaw === "UNAVAILABLE"
      || sessionFeeStatusRaw === "PENDING_PROVIDER_FEE"
      ? "PENDING_PROVIDER_FEE" as const
      : "CONFIRMED" as const);
  const authorisedPence = session?.authorised_amount_pence != null
    ? Math.max(0, session.authorised_amount_pence)
    : null;
  const releasedPence = session?.released_amount_pence != null
    ? Math.max(0, session.released_amount_pence)
    : null;
  const grossCommission = tripGrossCommissionPence(row);
  const onecabNet = onecabNetFromSessionFee({
    gross_commission_pence: grossCommission,
    provider_processing_fee_pence: processingFeePence,
    sessionsMapPresent,
  });

  // Payment Sessions owns expected capture / variance / classification.
  // FR consume-only: read persisted metadata.capture_breakdown — never rebuild from trip fare.
  const persistedBreakdown = readPersistedCaptureBreakdown(session?.metadata ?? null);
  const psCaptureBreakdown: PaymentSessionCaptureBreakdown | null = persistedBreakdown;
  const tipPence = Math.max(
    0,
    Number(
      psCaptureBreakdown?.tip_pence
        ?? row.tip_pence
        ?? row.tip_amount_pence
        ?? 0,
    ),
  );
  const airportPence = Math.max(
    0,
    Number(psCaptureBreakdown?.airport_charge_pence ?? row.airport_charge_pence ?? 0),
  );
  const expectedCapturePence = psCaptureBreakdown?.expected_capture_pence ?? null;
  const captureVariance = psCaptureBreakdown?.variance_pence ?? null;
  const rideFareForCapture = psCaptureBreakdown?.ride_fare_pence ?? null;
  // Customer capture variance is PS-owned only — never settlement_total − captured.
  const variancePence = captureVariance;
  const walletVariancePence = expectedDriverNet == null || walletCredit == null
    ? null
    : walletCredit - expectedDriverNet;

  const provider_state = session?.provider_state ?? null;
  const provider_verified_at = session?.provider_state_verified_at ?? null;
  const provider_verification_status = sessionsMapPresent && session != null
    ? classifyProviderVerificationStatus({
      provider_state,
      provider_verified_at,
    })
    : null;

  const psMatch = psCaptureBreakdown
    ? captureClassificationToMatchStatus(psCaptureBreakdown.capture_classification)
    : null;
  const capture_reconciliation_status = isCash
    ? "MATCHED"
    : payment_evidence_status === "PAYMENT_EVIDENCE_UNAVAILABLE"
    ? "PAYMENT_EVIDENCE_UNAVAILABLE"
    : payment_evidence_status === "NO_PAYMENT_SESSION"
    ? "NO_PAYMENT_SESSION"
    : provider_verification_status === "STALE"
    ? "PROVIDER_VERIFICATION_PENDING"
    : captured == null || captured <= 0
    ? "PAYMENT_SESSION_CAPTURE_MISMATCH"
    : psMatch == null
    ? "CAPTURE_AMOUNT_UNKNOWN" // PS breakdown not persisted yet — never invent OVERCAPTURE from trip fare
    : psMatch === "MATCHED"
    ? "MATCHED"
    : psMatch === "UNEXPLAINED_OVERCAPTURE"
    ? "OVERCAPTURE"
    : psMatch === "CAPTURE_SHORTFALL"
    ? "CAPTURE_SHORTFALL"
    : "CAPTURE_AMOUNT_UNKNOWN";
  const release_reconciliation_status = classifyReleaseReconciliation({
    authorised_pence: authorisedPence,
    captured_pence: captured,
    released_pence: releasedPence,
    release_evidence_status: session?.release_evidence_status != null
      ? String(session.release_evidence_status)
      : null,
  });
  const refund_reconciliation_status = classifyRefundReconciliation({
    refunded_pence: refunded,
  });
  const walletEvidenceAvailable = context.ledgerByTripId != null;
  const wallet_reconciliation_status = classifyWalletReconciliation({
    walletEvidenceAvailable,
    expected_driver_net_pence: expectedDriverNet,
    actual_wallet_credit_pence: walletCredit,
    duplicate_wallet_credit: walletEarning.entry_count > 1,
  });
  const payoutItems = context.payoutsByTripId.get(row.id) ?? [];
  const payoutEvidenceAvailable = context.payoutsByTripId != null;
  const payoutAmount = payoutItems.reduce(
    (s, p) => s + Math.max(0, Number(p.driver_amount_pence ?? p.amount_pence ?? 0)),
    0,
  );
  const payout_reconciliation_status = classifyPayoutReconciliation({
    payoutEvidenceAvailable,
    payout_status_label: statuses.driver_payout.label,
    payout_amount_pence: payoutAmount > 0 ? payoutAmount : null,
    eligible_amount_pence: availablePayoutCreated,
  });
  const payoutVariance = availablePayoutCreated == null || payoutAmount <= 0
    ? null
    : payoutAmount - availablePayoutCreated;

  const warnings: string[] = [];
  if (payment_evidence_status === "PAYMENT_EVIDENCE_UNAVAILABLE") {
    warnings.push("PAYMENT_EVIDENCE_UNAVAILABLE");
  }
  if (payment_evidence_status === "NO_PAYMENT_SESSION") {
    warnings.push("NO_PAYMENT_SESSION");
  }
  if (provider_verification_status === "STALE") {
    warnings.push("PROVIDER_VERIFICATION_PENDING");
  }
  if (!walletEvidenceAvailable) warnings.push("WALLET_EVIDENCE_UNAVAILABLE");
  if (!payoutEvidenceAvailable) warnings.push("PAYOUT_EVIDENCE_UNAVAILABLE");
  if (fee_status === "PENDING_PROVIDER_FEE") warnings.push("PROVIDER_FEE_PENDING");
  if (psCaptureBreakdown == null && !isCash && payment_evidence_status === "PAYMENT_SESSIONS") {
    warnings.push("PAYMENT_SESSION_CAPTURE_BREAKDOWN_PENDING");
  }

  // Capture mismatch is PS classification only — never trip settlement vs capture.
  const captureMismatchResolved = isCash
    ? false
    : capture_reconciliation_status === "OVERCAPTURE"
      || capture_reconciliation_status === "CAPTURE_SHORTFALL"
      || capture_reconciliation_status === "PAYMENT_SESSION_CAPTURE_MISMATCH"
      || capture_reconciliation_status === "NO_PAYMENT_SESSION"
      || (captured == null && payment_evidence_status === "PAYMENT_SESSIONS");

  let reconciliation_status = deriveTripReconciliationBadge({
    capture_mismatch: captureMismatchResolved,
    captured_pence: captured,
    refunded_pence: refunded,
    settlement_total_pence: settlementTotal,
    provider: statuses.provider,
    financial_outcome: row.financial_outcome ?? null,
    trip_status: row.status ?? null,
    payment_status: row.payment_status ?? null,
    capture_reconciliation_status,
    release_reconciliation_status,
    wallet_reconciliation_status,
    payout_reconciliation_status,
    fee_status,
  });

  const settlementIdentity = evaluateSettlementCaptureIdentity({
    captured_pence: captured,
    driver_net_pence: expectedDriverNet,
    commission_pence: grossCommission,
    airport_charge_pence: airportPence,
    tips_pence: tipPence,
  });
  const settlementIdentityBalanced = settlementIdentity.balanced;
  if (settlementIdentity.evaluable && !settlementIdentityBalanced) {
    reconciliation_status = {
      ...reconciliation_status,
      label: "SETTLEMENT_MISMATCH",
      tone: "error",
    };
  }

  const capture_status = deriveTripCaptureStatusLabel(statusInput, captureMismatchResolved);
  const paymentMethod = session?.payment_method ?? row.payment_method ?? null;

  return {
    trip_id: row.id,
    trip_code: row.trip_code ?? null,
    date: row.completed_at ?? null,
    created_at: row.created_at ?? null,
    driver_id: row.driver_id ?? null,
    customer_name: row.passenger_name?.trim() || null,
    driver_name: driverName,
    payment_method: paymentMethod,
    service_area_id: row.service_area_id ?? null,
    stripe_payment_intent_id: paymentIntentId,
    payment_session_id: session?.payment_session_id ?? null,
    customer_paid_pence: customerPaid,
    gross_fare_pence: grossFarePence,
    discount_pence: discountPence,
    final_fare_pence: finalFarePence,
    final_customer_fare_pence: rideFareForCapture,
    settlement_total_pence: settlementTotal,
    captured_pence: captured,
    refunded_pence: refunded,
    net_customer_payment_pence: customerPaid == null || refunded == null
      ? null
      : Math.max(0, customerPaid - refunded),
    outstanding_pence: outstanding,
    capture_mismatch: captureMismatchResolved,
    driver_net_pence: expectedDriverNet,
    debt_recovered_pence: debtRecovered,
    available_payout_created_pence: availablePayoutCreated,
    onecab_gross_commission_pence: grossCommission,
    processing_fee_pence: processingFeePence,
    onecab_net_pence: onecabNet,
    driver_payout: statuses.driver_payout,
    onecab_commission: statuses.onecab_commission,
    provider: statuses.provider,
    /** @deprecated Legacy string fields — kept for older admin clients */
    driver_payout_status: statuses.driver_payout.label,
    onecab_commission_status: statuses.onecab_commission.label,
    provider_status: statuses.provider.label,
    trip_status: row.status ?? null,
    financial_outcome: row.financial_outcome ?? null,
    payment_status: row.payment_status ?? null,
    capture_status,
    reconciliation_status,
    ride_fare_pence: rideFareForCapture,
    airport_charge_pence: airportPence,
    tip_pence: tipPence,
    authorised_pence: authorisedPence,
    released_pence: releasedPence,
    fee_status,
    wallet_credit_pence: walletCredit,
    variance_pence: variancePence,
    capture_variance_pence: captureVariance,
    wallet_variance_pence: walletVariancePence,
    payout_variance_pence: payoutVariance,
    payout_amount_pence: payoutAmount > 0 ? payoutAmount : null,
    capture_reconciliation_status,
    release_reconciliation_status,
    refund_reconciliation_status,
    wallet_reconciliation_status,
    payout_reconciliation_status,
    wallet_status: wallet_reconciliation_status,
    payment_evidence_status,
    provider_state,
    provider_verified_at,
    provider_verification_status,
    variance_reason: psCaptureBreakdown?.variance_reason ?? null,
    capture_classification: psCaptureBreakdown?.capture_classification ?? null,
    ps_expected_capture_pence: expectedCapturePence,
    settlement_identity_balanced: settlementIdentityBalanced,
    fr_trip_audit_status: resolveFrTripAuditStatus({
      capture_reconciliation_status,
      release_reconciliation_status,
      wallet_reconciliation_status,
      payout_reconciliation_status,
      fee_status,
      settlement_identity_balanced: settlementIdentityBalanced,
      payment_evidence_status,
    }),
    pickup_waiting_charge_pence: psCaptureBreakdown?.pickup_waiting_charge_pence ?? null,
    stop_waiting_charge_pence: psCaptureBreakdown?.stop_waiting_charge_pence ?? null,
    capture_breakdown: psCaptureBreakdown
      ? {
        ride_fare_pence: psCaptureBreakdown.ride_fare_pence,
        pickup_waiting_charge_pence: psCaptureBreakdown.pickup_waiting_charge_pence,
        stop_waiting_charge_pence: psCaptureBreakdown.stop_waiting_charge_pence,
        expected_capture_pence: psCaptureBreakdown.expected_capture_pence,
        provider_captured_pence: psCaptureBreakdown.provider_captured_pence,
        variance_pence: psCaptureBreakdown.variance_pence,
        variance_reason: psCaptureBreakdown.variance_reason,
        capture_classification: psCaptureBreakdown.capture_classification,
      }
      : null,
    warnings: psCaptureBreakdown?.variance_reason
      ? [...warnings, psCaptureBreakdown.variance_reason]
      : warnings,
    settlement_formula_version: "fr_trip_audit_v1",
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
  paymentSessions?: PaymentSessionMoneyRow[];
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

  const paymentSessionByTripId = args.paymentSessions
    ? buildPaymentSessionMoneyByTrip(args.paymentSessions)
    : undefined;

  return {
    paymentByTripId,
    paymentsByTripId,
    payoutsByTripId,
    ledgerByTripId,
    paymentSessionByTripId,
    currencyCodeByServiceAreaId: args.currencyCodeByServiceAreaId,
    defaultCurrencyCode: args.defaultCurrencyCode ?? null,
  };
}

export function sumCommissionableFromTrips(
  rows: TripAuditSourceRow[],
  paymentByTrip?: Map<string, number>,
): number {
  let total = 0;
  for (const row of rows) {
    const method = String(row.payment_method ?? "").toLowerCase();
    const isCash = method === "cash" || method.includes("cash");
    const captured = confirmedCapturePence(paymentByTrip?.get(row.id));
    const tip = Math.max(0, row.tip_pence ?? row.tip_amount_pence ?? 0);
    const airport = Math.max(0, row.airport_charge_pence ?? 0);
    const passThrough = Math.max(0, row.other_pass_through_charges_pence ?? 0);
    const refunded = Math.max(0, row.refund_amount_pence ?? 0);
    if (captured != null && captured > 0) {
      total += commissionableRevenueFromCaptured({
        capturedPence: captured,
        tipPence: tip,
        airportPence: airport,
        passThroughPence: passThrough,
        refundedPence: refunded,
      });
    } else if (isCash) {
      total += commissionableRevenuePence(row);
    }
    // Digital without Payment Sessions capture: do not invent from trip.capture_amount_pence.
  }
  return total;
}
