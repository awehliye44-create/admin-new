import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildInsufficientFundsDiagnosis,
  buildFinanceReconciliationSummary,
  classifyOnecabSettlementStatus,
  computeSafePayoutAmount,
  mapTripToFinancialAuditRow,
  parseInsufficientFundsReason,
  partitionStripePlatformCash,
  reconcileStripeBalance,
  sumTripFinanceMetrics,
  buildTripFinancialAuditContext,
} from "./financeSettlementSummary.ts";

const TRIP_5783 = {
  commission_pence: 867,
  stripe_processing_fee_pence: 120,
  onecab_net_pence: 747,
  driver_net_pence: 4916,
  gross_fare_pence: 5783,
  final_fare_pence: 5783,
  commissionable_fare_pence: 5783,
  capture_amount_pence: 5783,
  tip_pence: 0,
  tip_amount_pence: null,
  payment_method: "card",
  stripe_settlement_verified: true,
  driver_tier_commission_percent: 15,
  commission_pct: 15,
  completed_at: "2026-06-09T12:00:00Z",
};

Deno.test("£57.83 revenue → ONECAB gross commission max £8.67 at 15%", () => {
  const m = sumTripFinanceMetrics([TRIP_5783]);
  assertEquals(m.total_customer_revenue_pence, 5783);
  assertEquals(m.max_commission_at_15_percent_pence, 867);
  assertEquals(m.onecab_gross_commission_pence, 867);
  assertEquals(m.onecab_net_pence, 747);
  assertEquals(m.commission_exceeds_15_percent_cap, false);
});

Deno.test("mislabeled stripe-minus-driver (£28.87) is NOT commission", () => {
  const stripeAvailable = 5783;
  const driverPayable = 2896;
  const partition = partitionStripePlatformCash({
    stripeAvailablePence: stripeAvailable,
    driverPayoutLiabilityPence: driverPayable,
    pendingTransfersPence: 0,
  });
  assertEquals(partition.unallocated_platform_cash_pence, 2887);
  const m = sumTripFinanceMetrics([TRIP_5783]);
  assertEquals(m.onecab_gross_commission_pence, 867);
  assertEquals(partition.unallocated_platform_cash_pence !== m.onecab_gross_commission_pence, true);
});

Deno.test("reconcile uses trip-derived ONECAB net not stripe minus driver", () => {
  const m = sumTripFinanceMetrics([TRIP_5783]);
  const r = reconcileStripeBalance({
    stripeAvailablePence: 5783,
    calculatedOnecabNetPence: m.onecab_net_pence,
    availableDriverPayablePence: 4916,
    pendingTransfersPence: 0,
  });
  assertEquals(r.calculated_onecab_net_pence, 747);
  assertEquals(r.calculated_onecab_net_pence, 747);
});

Deno.test("commission cap flags driver net mistaken as commission", () => {
  const bad = sumTripFinanceMetrics([{
    ...TRIP_5783,
    commission_pence: 2887,
    onecab_net_pence: 2767,
  }]);
  assertEquals(bad.commission_exceeds_15_percent_cap, true);
});

Deno.test("computeSafePayoutAmount caps to Stripe available balance", () => {
  const r = computeSafePayoutAmount({ driverAvailablePence: 5000, stripeAvailablePence: 3200 });
  assertEquals(r.payout_amount_pence, 3200);
  assertEquals(r.waiting_for_stripe_funds, true);
});

Deno.test("buildFinanceReconciliationSummary balances card ledger", async () => {
  const { computeSSOTMetrics } = await import("./financialReconciliationSSOT.ts");
  const ssot = computeSSOTMetrics({
    payments: [{ trip_id: "t1", captured_amount_pence: 5783, status: "captured" }],
    trips: [{ ...TRIP_5783, id: "t1" }],
    ledger: [],
    providerAvailableBalancePence: 5783,
    providerPendingBalancePence: 0,
  });
  const summary = buildFinanceReconciliationSummary({
    ssot,
    commissionableRevenuePence: 5783,
    driverWalletBalancePence: 4916,
    inFlightCashoutPence: 0,
    settlementStatus: "available_in_stripe_balance",
    settlementStatusLabel: "Available",
    providerHealthStatus: "healthy",
    lastWebhookReceivedAt: null,
  });
  assertEquals(summary.reconciliation_check.balanced, true);
  assertEquals(summary.onecab_money.onecab_card_commission_pence, 867);
  assertEquals(summary.driver_money.card_driver_payable_pence, 4916);
});

Deno.test("classifyOnecabSettlementStatus never marks paid without verification", () => {
  assertEquals(
    classifyOnecabSettlementStatus({
      calculatedOnecabNetPence: 747,
      verifiedOnecabNetPence: 0,
      stripeAvailablePence: 5783,
      stripePendingPence: 0,
      verifiedTripCount: 0,
      tripCount: 1,
    }),
    "calculated_only",
  );
});

const MK_260615_006 = {
  id: "trip-006",
  trip_code: "MK-260615-006",
  payment_method: "card",
  payment_status: "captured",
  final_fare_pence: 512,
  gross_fare_pence: 480,
  capture_amount_pence: 480,
  commission_pence: 77,
  driver_net_pence: 435,
  stripe_processing_fee_pence: null,
  onecab_net_pence: null,
  commissionable_fare_pence: null,
  tip_pence: 0,
  tip_amount_pence: null,
  stripe_settlement_verified: true,
  driver_tier_commission_percent: null,
  commission_pct: null,
  completed_at: "2026-06-15T12:00:00Z",
};

Deno.test("Financial Reconciliation audit: card captured uses payments.captured_amount_pence not legacy fare", () => {
  const context = buildTripFinancialAuditContext({
    payments: [{
      trip_id: "trip-006",
      status: "captured",
      provider_status: "available",
      captured_amount_pence: 512,
    }],
    payoutItems: [],
    ledgerRows: [],
  });
  const row = mapTripToFinancialAuditRow(MK_260615_006, context);
  assertEquals(row.customer_paid_pence, 512);
  assertEquals(row.captured_pence, 512);
});

Deno.test("Financial Reconciliation audit: driver net from trips.driver_net_pence, not captured − commission", () => {
  const context = buildTripFinancialAuditContext({
    payments: [{
      trip_id: "trip-006",
      status: "captured",
      provider_status: "available",
      captured_amount_pence: 512,
    }],
    payoutItems: [],
    ledgerRows: [],
  });
  const row = mapTripToFinancialAuditRow(MK_260615_006, context);
  assertEquals(row.driver_net_pence, 435);
});

Deno.test("Financial Reconciliation audit: prefers ledger TRIP_EARNING_NET over trips.driver_net_pence", () => {
  const context = buildTripFinancialAuditContext({
    payments: [{
      trip_id: "trip-006",
      status: "captured",
      provider_status: "available",
      captured_amount_pence: 512,
    }],
    payoutItems: [],
    ledgerRows: [{
      related_trip_id: "trip-006",
      type: "TRIP_EARNING_NET",
      amount_pence: 435,
    }],
  });
  const row = mapTripToFinancialAuditRow(MK_260615_006, context);
  assertEquals(row.driver_net_pence, 435);
});

Deno.test("Financial Reconciliation audit: missing driver net is null, not fare − commission", () => {
  const trip = {
    ...MK_260615_006,
    driver_net_pence: null,
  };
  const context = buildTripFinancialAuditContext({
    payments: [{
      trip_id: "trip-006",
      status: "captured",
      provider_status: "available",
      captured_amount_pence: 512,
    }],
    payoutItems: [],
    ledgerRows: [],
  });
  const row = mapTripToFinancialAuditRow(trip, context);
  assertEquals(row.driver_net_pence, null);
});

Deno.test("Financial Reconciliation audit: cash trip uses final_fare_pence as customer paid", () => {
  const cashTrip = {
    id: "trip-004",
    trip_code: "MK-260615-004",
    payment_method: "cash",
    payment_status: "collected_cash",
    final_fare_pence: 793,
    gross_fare_pence: 793,
    capture_amount_pence: 0,
    commission_pence: 106,
    driver_net_pence: 687,
    stripe_processing_fee_pence: null,
    onecab_net_pence: null,
    commissionable_fare_pence: null,
    tip_pence: 0,
    tip_amount_pence: null,
    stripe_settlement_verified: null,
    driver_tier_commission_percent: null,
    commission_pct: null,
    completed_at: "2026-06-15T12:00:00Z",
  };
  const context = buildTripFinancialAuditContext({
    payments: [],
    payoutItems: [],
    ledgerRows: [],
  });
  const row = mapTripToFinancialAuditRow(cashTrip, context);
  assertEquals(row.customer_paid_pence, 793);
  assertEquals(row.driver_net_pence, 687);
});

Deno.test("Financial Reconciliation audit: capture mismatch + outstanding from settlement − captured", () => {
  const trip = {
    ...MK_260615_006,
    final_fare_pence: 849,
    outstanding_balance_pence: 449,
  };
  const context = buildTripFinancialAuditContext({
    payments: [{
      trip_id: "trip-006",
      status: "captured",
      provider_status: "available",
      captured_amount_pence: 400,
    }],
    payoutItems: [],
    ledgerRows: [],
  });
  const row = mapTripToFinancialAuditRow(trip, context);
  assertEquals(row.settlement_total_pence, 849);
  assertEquals(row.captured_pence, 400);
  assertEquals(row.outstanding_pence, 449);
  assertEquals(row.capture_mismatch, true);
});
