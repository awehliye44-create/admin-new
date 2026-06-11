/**
 * ONECAB commission vs driver payout visibility — shared types + helpers.
 *
 * CRITICAL: ONECAB gross commission = sum(trips.commission_pence) only.
 * Never use Stripe available balance, captured revenue, or driver payable as commission.
 */

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
      row.gross_fare_pence ??
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

export function tripStripeFeePence(row: TripFinanceRow): number {
  return Math.max(0, row.stripe_processing_fee_pence ?? 0);
}

export function tripOnecabNetPence(row: TripFinanceRow): number {
  if (row.onecab_net_pence != null) return Math.max(0, row.onecab_net_pence);
  return Math.max(0, tripGrossCommissionPence(row) - tripStripeFeePence(row));
}

export function tripDriverNetPence(row: TripFinanceRow): number {
  if (row.driver_net_pence != null) return Math.max(0, row.driver_net_pence);
  const commissionable = commissionableRevenuePence(row);
  const commission = tripGrossCommissionPence(row);
  if (commissionable > 0 && commission > 0) return Math.max(0, commissionable - commission);
  return 0;
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
    const driverNet = tripDriverNetPence(row);

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
    total_customer_revenue_pence: number;
    refunded_amount_pence: number;
    net_customer_revenue_pence: number;
    commissionable_revenue_pence: number;
  };
  driver_money: {
    driver_gross_earnings_pence: number;
    driver_net_earnings_pence: number;
    driver_wallet_balance_pence: number;
    driver_available_payout_pence: number;
    driver_pending_payout_pence: number;
    driver_paid_out_pence: number;
    driver_payout_liability_pence: number;
    in_flight_cashout_pence: number;
  };
  onecab_money: {
    onecab_gross_commission_pence: number;
    provider_processing_fee_pence: number;
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
    net_customer_revenue_pence: number;
    driver_net_earnings_pence: number;
    onecab_gross_commission_pence: number;
    provider_processing_fee_pence: number;
    adjustments_pence: number;
    expected_sum_pence: number;
    delta_pence: number;
    balanced: boolean;
    status: "balanced" | "reconciliation_error";
  };
};

export type TripFinancialAuditRow = {
  trip_id: string;
  trip_code: string | null;
  date: string | null;
  driver_name: string | null;
  customer_paid_pence: number;
  captured_pence: number;
  refunded_pence: number;
  net_customer_payment_pence: number;
  driver_net_pence: number;
  onecab_gross_commission_pence: number;
  processing_fee_pence: number;
  onecab_net_pence: number;
  driver_payout_status: string;
  onecab_commission_status: string;
  provider_status: string;
};

export type TripAuditSourceRow = TripFinanceRow & {
  id: string;
  trip_code?: string | null;
  refund_amount_pence?: number | null;
  airport_charge_pence?: number | null;
  other_pass_through_charges_pence?: number | null;
  payment_status?: string | null;
  financial_outcome?: string | null;
  driver?: { first_name?: string | null; last_name?: string | null } | null;
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

export function buildFinanceReconciliationSummary(args: {
  tripMetrics: ReturnType<typeof sumTripFinanceMetrics>;
  refundedAmountPence: number;
  commissionableRevenuePence: number;
  driverWalletBalancePence: number;
  driverSettledEligiblePence: number;
  driverPaidOutPence: number;
  inFlightCashoutPence: number;
  pendingTransfersPence: number;
  stripeAvailablePence: number;
  stripePendingPence: number;
  settlementStatus: OnecabSettlementStatus;
  settlementStatusLabel: string;
  providerHealthStatus: FinanceReconciliationSummary["provider_money"]["provider_health_status"];
  lastWebhookReceivedAt: string | null;
  adjustmentsPence?: number;
  onecabBankPayoutPence?: number;
  tolerancePence?: number;
}): FinanceReconciliationSummary {
  const adjustments = args.adjustmentsPence ?? 0;
  const netCustomerRevenue = Math.max(0, args.tripMetrics.total_customer_revenue_pence - args.refundedAmountPence);

  const driverAvailableRaw = Math.min(
    Math.max(0, args.driverSettledEligiblePence),
    Math.max(0, args.stripeAvailablePence),
  );
  const driverAvailablePayout = Math.max(0, driverAvailableRaw - args.inFlightCashoutPence);

  const driverPendingPayout = Math.max(
    0,
    args.driverWalletBalancePence -
      driverAvailablePayout -
      args.driverPaidOutPence -
      args.inFlightCashoutPence,
  );

  const expectedSum =
    args.tripMetrics.driver_net_earnings_pence +
    args.tripMetrics.onecab_gross_commission_pence +
    adjustments;
  const delta = netCustomerRevenue - expectedSum;
  const tolerance = args.tolerancePence ?? 100;
  const balanced = Math.abs(delta) <= tolerance;

  return {
    customer_revenue: {
      total_customer_revenue_pence: args.tripMetrics.total_customer_revenue_pence,
      refunded_amount_pence: args.refundedAmountPence,
      net_customer_revenue_pence: netCustomerRevenue,
      commissionable_revenue_pence: args.commissionableRevenuePence,
    },
    driver_money: {
      driver_gross_earnings_pence: args.tripMetrics.driver_gross_earnings_pence,
      driver_net_earnings_pence: args.tripMetrics.driver_net_earnings_pence,
      driver_wallet_balance_pence: args.driverWalletBalancePence,
      driver_available_payout_pence: driverAvailablePayout,
      driver_pending_payout_pence: driverPendingPayout,
      driver_paid_out_pence: args.driverPaidOutPence,
      driver_payout_liability_pence: args.driverSettledEligiblePence,
      in_flight_cashout_pence: args.inFlightCashoutPence,
    },
    onecab_money: {
      onecab_gross_commission_pence: args.tripMetrics.onecab_gross_commission_pence,
      provider_processing_fee_pence: args.tripMetrics.stripe_fee_pence,
      onecab_net_commission_pence: args.tripMetrics.onecab_net_pence,
      onecab_bank_payout_pence: args.onecabBankPayoutPence ?? 0,
      onecab_commission_status: args.settlementStatus,
      onecab_commission_status_label: args.settlementStatusLabel,
    },
    provider_money: {
      provider_name: "Stripe",
      provider_available_balance_pence: args.stripeAvailablePence,
      provider_pending_balance_pence: args.stripePendingPence,
      provider_health_status: args.providerHealthStatus,
      last_webhook_received_at: args.lastWebhookReceivedAt,
    },
    reconciliation_check: {
      net_customer_revenue_pence: netCustomerRevenue,
      driver_net_earnings_pence: args.tripMetrics.driver_net_earnings_pence,
      onecab_gross_commission_pence: args.tripMetrics.onecab_gross_commission_pence,
      provider_processing_fee_pence: args.tripMetrics.stripe_fee_pence,
      adjustments_pence: adjustments,
      expected_sum_pence: expectedSum,
      delta_pence: delta,
      balanced,
      status: balanced ? "balanced" : "reconciliation_error",
    },
  };
}

export function classifyDriverPayoutStatus(paymentStatus: string | null | undefined): string {
  const s = String(paymentStatus || "").toLowerCase();
  if (s.includes("failed")) return "Payout Failed";
  if (s === "paid" || s === "completed") return "Paid To Driver";
  if (s.includes("pending") || s === "processing") return "Awaiting Settlement";
  return "Awaiting Settlement";
}

export function classifyOnecabCommissionStatus(args: {
  stripeSettlementVerified: boolean | null;
  paymentStatus: string | null | undefined;
  refundAmountPence: number;
  capturedPence: number;
}): string {
  const refunded = args.refundAmountPence ?? 0;
  const captured = args.capturedPence ?? 0;
  if (refunded > 0 && captured > 0 && refunded >= captured) return "Refunded";
  if (refunded > 0) return "Partially Refunded";
  if (args.stripeSettlementVerified === true) return "Provider Settled";
  return "Awaiting Settlement";
}

export function classifyProviderTripStatus(args: {
  stripeSettlementVerified: boolean | null;
  paymentStatus: string | null | undefined;
}): string {
  if (args.stripeSettlementVerified === true) return "Provider Settled";
  const s = String(args.paymentStatus || "").toLowerCase();
  if (s.includes("failed")) return "Webhook Failing";
  if (s.includes("refund")) return "Refunded";
  return "Awaiting Settlement";
}

export function mapTripToFinancialAuditRow(row: TripAuditSourceRow): TripFinancialAuditRow {
  const captured = Math.max(0, row.capture_amount_pence ?? 0);
  const refunded = Math.max(0, row.refund_amount_pence ?? 0);
  const tip = Math.max(0, row.tip_pence ?? row.tip_amount_pence ?? 0);
  const customerPaid = captured > 0 ? captured : customerRevenuePence(row);
  const driverName = row.driver
    ? [row.driver.first_name, row.driver.last_name].filter(Boolean).join(" ").trim() || null
    : null;

  return {
    trip_id: row.id,
    trip_code: row.trip_code ?? null,
    date: row.completed_at ?? null,
    driver_name: driverName,
    customer_paid_pence: customerPaid,
    captured_pence: captured,
    refunded_pence: refunded,
    net_customer_payment_pence: Math.max(0, customerPaid - refunded),
    driver_net_pence: tripDriverNetPence(row),
    onecab_gross_commission_pence: tripGrossCommissionPence(row),
    processing_fee_pence: tripStripeFeePence(row),
    onecab_net_pence: tripOnecabNetPence(row),
    driver_payout_status: classifyDriverPayoutStatus(row.payment_status),
    onecab_commission_status: classifyOnecabCommissionStatus({
      stripeSettlementVerified: row.stripe_settlement_verified,
      paymentStatus: row.payment_status,
      refundAmountPence: refunded,
      capturedPence: captured,
    }),
    provider_status: classifyProviderTripStatus({
      stripeSettlementVerified: row.stripe_settlement_verified,
      paymentStatus: row.payment_status,
    }),
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
