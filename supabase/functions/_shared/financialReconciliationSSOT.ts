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

export const SSOT_VERSION = "financial_reconciliation_ssot_v1";

export type FinanceDataSourceBadge = "LIVE" | "SUMMARY" | "LEDGER" | "RECONSTRUCTED";

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
  id?: string;
};

/** Fare = base_fare + extras (commissionable), excluding tips. */
export function tripFarePence(row: TripSSOTRow): number {
  return Math.max(
    0,
    row.commissionable_fare_pence ?? row.gross_fare_pence ?? row.final_fare_pence ?? 0,
  );
}

export function tripTipsPence(row: TripSSOTRow): number {
  return Math.max(0, row.tip_pence ?? row.tip_amount_pence ?? 0);
}

export function isCashTrip(row: TripSSOTRow): boolean {
  return String(row.payment_method ?? "").toUpperCase() === "CASH";
}

export function tripDriverNetPence(row: TripSSOTRow): number {
  if (row.driver_net_pence != null) return Math.max(0, row.driver_net_pence);
  const fare = tripFarePence(row);
  const commission = Math.max(0, row.commission_pence ?? 0);
  return Math.max(0, fare - commission);
}

export function tripCommissionPence(row: TripSSOTRow): number {
  return Math.max(0, row.commission_pence ?? 0);
}

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

/** Tips pass through to drivers — included in customer capture but not in commission. */
export function sumTipsPence(trips: TripSSOTRow[]): number {
  return trips.reduce((s, t) => s + Math.max(0, t.tip_pence ?? t.tip_amount_pence ?? 0), 0);
}

/** 3. Net customer revenue */
export function netCustomerRevenuePence(total: number, refunded: number): number {
  return Math.max(0, total - refunded);
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

/** Per-driver remaining liability — bank payouts + completed early cashouts deducted separately. */
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
 * Cash/wallet reconciliation.
 * remaining_liability already includes adjustments (driver_net - paid_out + adjustments),
 * so adjustments must NOT be added again on the RHS.
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
  const rhs =
    args.driverPaidOutPence +
    args.driverRemainingLiabilityPence +
    args.onecabNetCommissionPence +
    args.providerProcessingFeePence;
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

export type PaymentMethodLedgerMetrics = {
  card_customer_revenue_pence: number;
  card_refunded_pence: number;
  net_card_revenue_pence: number;
  card_driver_payable_pence: number;
  onecab_card_commission_pence: number;
  stripe_processing_fees_pence: number;
  onecab_card_net_commission_pence: number;
  cash_collected_by_driver_pence: number;
  cash_driver_already_received_pence: number;
  onecab_cash_commission_receivable_pence: number;
  cash_tips_collected_by_driver_pence: number;
  card_trip_count: number;
  cash_trip_count: number;
};

function cardCustomerRevenueForTrip(
  row: TripSSOTRow,
  paymentByTripId: Map<string, PaymentCaptureRow>,
): number {
  const tips = tripTipsPence(row);
  const payment = paymentByTripId.get(row.id ?? "");
  if (payment && CAPTURED_PAYMENT_STATUSES.has(String(payment.status ?? "").toLowerCase())) {
    return Math.max(0, payment.captured_amount_pence ?? 0);
  }
  const captured = Math.max(0, row.capture_amount_pence ?? 0);
  if (captured > 0) return captured;
  return tripFarePence(row) + tips;
}

/** Split trip economics by payment method — card Stripe ledger vs cash collected by driver. */
export function computePaymentMethodLedgerMetrics(args: {
  trips: TripSSOTRow[];
  payments?: PaymentCaptureRow[];
}): PaymentMethodLedgerMetrics {
  const paymentByTripId = new Map<string, PaymentCaptureRow>();
  for (const p of args.payments ?? []) {
    if (p.trip_id) paymentByTripId.set(p.trip_id, p);
  }

  let cardCustomerRevenue = 0;
  let cardRefunded = 0;
  let cardDriverPayable = 0;
  let onecabCardCommission = 0;
  let stripeFees = 0;
  let cashCollected = 0;
  let cashDriverReceived = 0;
  let onecabCashCommission = 0;
  let cashTips = 0;
  let cardTripCount = 0;
  let cashTripCount = 0;

  for (const row of args.trips) {
    const fare = tripFarePence(row);
    const tips = tripTipsPence(row);
    const commission = tripCommissionPence(row);
    const driverNet = tripDriverNetPence(row);
    const refunded = Math.max(0, row.refund_amount_pence ?? 0);

    if (isCashTrip(row)) {
      cashTripCount += 1;
      cashCollected += fare;
      cashDriverReceived += driverNet;
      onecabCashCommission += commission;
      cashTips += tips;
      continue;
    }

    cardTripCount += 1;
    cardCustomerRevenue += cardCustomerRevenueForTrip(
      row,
      paymentByTripId,
    );
    cardRefunded += refunded;
    cardDriverPayable += driverNet + tips;
    onecabCardCommission += commission;
    stripeFees += Math.max(0, row.stripe_processing_fee_pence ?? 0);
  }

  return {
    card_customer_revenue_pence: cardCustomerRevenue,
    card_refunded_pence: cardRefunded,
    net_card_revenue_pence: Math.max(0, cardCustomerRevenue - cardRefunded),
    card_driver_payable_pence: cardDriverPayable,
    onecab_card_commission_pence: onecabCardCommission,
    stripe_processing_fees_pence: stripeFees,
    onecab_card_net_commission_pence: Math.max(0, onecabCardCommission - stripeFees),
    cash_collected_by_driver_pence: cashCollected,
    cash_driver_already_received_pence: cashDriverReceived,
    onecab_cash_commission_receivable_pence: onecabCashCommission,
    cash_tips_collected_by_driver_pence: cashTips,
    card_trip_count: cardTripCount,
    cash_trip_count: cashTripCount,
  };
}

/** CARD: customer revenue = driver payable + ONECAB commission (card trips only). */
export function buildCardReconciliationCheck(args: {
  cardCustomerRevenuePence: number;
  cardDriverPayablePence: number;
  onecabCardCommissionPence: number;
  tolerancePence?: number;
}) {
  const rhs = args.cardDriverPayablePence + args.onecabCardCommissionPence;
  const variance = args.cardCustomerRevenuePence - rhs;
  const tolerance = args.tolerancePence ?? 100;
  const balanced = Math.abs(variance) <= tolerance;

  return {
    card_customer_revenue_pence: args.cardCustomerRevenuePence,
    card_driver_payable_pence: args.cardDriverPayablePence,
    onecab_card_commission_pence: args.onecabCardCommissionPence,
    expected_sum_pence: rhs,
    variance_pence: variance,
    delta_pence: variance,
    balanced,
    status: balanced ? ("BALANCED" as const) : ("RECONCILIATION_MISMATCH" as const),
  };
}

/** CASH: fare collected by driver = driver already received + ONECAB commission receivable. */
export function buildCashReconciliationCheck(args: {
  cashCollectedByDriverPence: number;
  cashDriverAlreadyReceivedPence: number;
  onecabCashCommissionReceivablePence: number;
  tolerancePence?: number;
}) {
  const rhs = args.cashDriverAlreadyReceivedPence + args.onecabCashCommissionReceivablePence;
  const variance = args.cashCollectedByDriverPence - rhs;
  const tolerance = args.tolerancePence ?? 100;
  const balanced = Math.abs(variance) <= tolerance;

  return {
    cash_collected_by_driver_pence: args.cashCollectedByDriverPence,
    cash_driver_already_received_pence: args.cashDriverAlreadyReceivedPence,
    onecab_cash_commission_receivable_pence: args.onecabCashCommissionReceivablePence,
    expected_sum_pence: rhs,
    variance_pence: variance,
    delta_pence: variance,
    balanced,
    status: balanced ? ("BALANCED" as const) : ("RECONCILIATION_MISMATCH" as const),
  };
}

export function buildSplitReconciliationCheck(args: {
  ledger: PaymentMethodLedgerMetrics;
  tolerancePence?: number;
}) {
  const card = buildCardReconciliationCheck({
    cardCustomerRevenuePence: args.ledger.card_customer_revenue_pence,
    cardDriverPayablePence: args.ledger.card_driver_payable_pence,
    onecabCardCommissionPence: args.ledger.onecab_card_commission_pence,
    tolerancePence: args.tolerancePence,
  });
  const cash = buildCashReconciliationCheck({
    cashCollectedByDriverPence: args.ledger.cash_collected_by_driver_pence,
    cashDriverAlreadyReceivedPence: args.ledger.cash_driver_already_received_pence,
    onecabCashCommissionReceivablePence: args.ledger.onecab_cash_commission_receivable_pence,
    tolerancePence: args.tolerancePence,
  });
  const balanced = card.balanced && cash.balanced;

  return {
    card_reconciliation: card,
    cash_reconciliation: cash,
    balanced,
    status: balanced ? ("BALANCED" as const) : ("RECONCILIATION_MISMATCH" as const),
  };
}

/**
 * Trip-earnings split for a bounded period.
 * @deprecated Mixed card+cash check — use buildSplitReconciliationCheck instead.
 */
export function buildTripEarningsReconciliationCheck(args: {
  netCustomerRevenuePence: number;
  driverNetEarningsPence: number;
  onecabGrossCommissionPence: number;
  tipsPence?: number;
  tolerancePence?: number;
}) {
  const rhs = args.driverNetEarningsPence + args.onecabGrossCommissionPence + Math.max(0, args.tipsPence ?? 0);
  const variance = args.netCustomerRevenuePence - rhs;
  const tolerance = args.tolerancePence ?? 100;
  const balanced = Math.abs(variance) <= tolerance;

  return {
    net_customer_revenue_pence: args.netCustomerRevenuePence,
    driver_net_earnings_pence: args.driverNetEarningsPence,
    onecab_gross_commission_pence: args.onecabGrossCommissionPence,
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
  tips_pence: number;
  adjustments_pence: number;
  driver_remaining_liability_pence: number;
  driver_available_now_pence: number;
  driver_pending_payout_pence: number;
  provider_available_balance_pence: number;
  provider_pending_balance_pence: number;
  ledger_split: PaymentMethodLedgerMetrics;
};

export function computeSSOTMetrics(args: {
  payments: PaymentCaptureRow[];
  trips: TripSSOTRow[];
  ledger: LedgerSSOTRow[];
  providerAvailableBalancePence: number;
  providerPendingBalancePence: number;
}): SSOTComputedMetrics {
  const ledgerSplit = computePaymentMethodLedgerMetrics({
    trips: args.trips,
    payments: args.payments,
  });
  const customerRev = sumCustomerRevenuePence({ payments: args.payments, trips: args.trips });
  const refunded = sumRefundedPence(args.trips);
  const netCustomer = netCustomerRevenuePence(customerRev.total_pence, refunded);
  const driverGross = sumDriverGrossEarningsPence(args.trips);
  const driverNet = sumDriverNetEarningsPence(args.trips);
  const onecabGross = sumOnecabGrossCommissionPence(args.trips);
  const providerFees = ledgerSplit.stripe_processing_fees_pence;
  const onecabNet = ledgerSplit.onecab_card_net_commission_pence;
  const paidOut = sumDriverPaidOutPence(args.ledger);
  const adjustments = sumAdjustmentsPence(args.ledger);
  const tips = sumTipsPence(args.trips);
  /** Card driver payable only — cash driver_net is already in the driver's hand. */
  const remaining = driverRemainingLiabilityPence({
    driverNetEarningsPence: ledgerSplit.card_driver_payable_pence,
    driverPaidOutPence: paidOut,
    adjustmentsPence: adjustments,
  });
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
    tips_pence: tips,
    adjustments_pence: adjustments,
    driver_remaining_liability_pence: remaining,
    driver_available_now_pence: availableNow,
    driver_pending_payout_pence: pendingPayout,
    provider_available_balance_pence: args.providerAvailableBalancePence,
    provider_pending_balance_pence: args.providerPendingBalancePence,
    ledger_split: ledgerSplit,
  };
}
