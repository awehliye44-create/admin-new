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
  // Digital customer revenue is owned by Payment Sessions — never invent from trip capture.
  assertEquals(m.total_customer_revenue_pence, 0);
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

Deno.test("Financial Reconciliation audit: card captured uses Payment Sessions only, not legacy fare", () => {
  const context = buildTripFinancialAuditContext({
    payments: [],
    payoutItems: [],
    ledgerRows: [],
    paymentSessions: [{
      id: "ps-006",
      trip_id: "trip-006",
      status: "captured",
      captured_amount_pence: 512,
    }],
  });
  const row = mapTripToFinancialAuditRow(MK_260615_006, context);
  assertEquals(row.customer_paid_pence, 512);
  assertEquals(row.captured_pence, 512);
  assertEquals(row.payment_session_id, "ps-006");
  assertEquals(row.payment_evidence_status, "PAYMENT_SESSIONS");
});

Deno.test("Financial Reconciliation audit: driver net from trips.driver_net_pence, not captured − commission", () => {
  const context = buildTripFinancialAuditContext({
    payments: [],
    payoutItems: [],
    ledgerRows: [],
    paymentSessions: [{ id: "ps-006", trip_id: "trip-006", status: "captured", captured_amount_pence: 512 }],
  });
  const row = mapTripToFinancialAuditRow(MK_260615_006, context);
  assertEquals(row.driver_net_pence, 435);
});

Deno.test("Financial Reconciliation audit: driver_net from trip settlement; wallet_credit from ledger", () => {
  const context = buildTripFinancialAuditContext({
    payments: [],
    payoutItems: [],
    ledgerRows: [{
      related_trip_id: "trip-006",
      type: "TRIP_EARNING_NET",
      amount_pence: 999,
    }],
    paymentSessions: [{ id: "ps-006", trip_id: "trip-006", status: "captured", captured_amount_pence: 512 }],
  });
  const row = mapTripToFinancialAuditRow(MK_260615_006, context);
  assertEquals(row.driver_net_pence, 435);
  assertEquals(row.wallet_credit_pence, 999);
  assertEquals(row.wallet_variance_pence, 999 - 435);
  assertEquals(row.wallet_reconciliation_status, "WALLET_OVER_CREDIT");
  assertEquals(row.capture_reconciliation_status, "MATCHED");
});

Deno.test("Financial Reconciliation audit: missing driver net is null, not fare − commission", () => {
  const trip = {
    ...MK_260615_006,
    driver_net_pence: null,
  };
  const context = buildTripFinancialAuditContext({
    payments: [],
    payoutItems: [],
    ledgerRows: [],
    paymentSessions: [{ id: "ps-006", trip_id: "trip-006", status: "captured", captured_amount_pence: 512 }],
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
    payments: [],
    payoutItems: [],
    ledgerRows: [],
    paymentSessions: [{ id: "ps-006", trip_id: "trip-006", status: "captured", captured_amount_pence: 400 }],
  });
  const row = mapTripToFinancialAuditRow(trip, context);
  assertEquals(row.settlement_total_pence, 849);
  assertEquals(row.captured_pence, 400);
  assertEquals(row.outstanding_pence, 449);
  assertEquals(row.capture_mismatch, true);
});

Deno.test("MK-260624-001 recovered: sum all payment PIs — no mismatch when £4.49 extra captured", () => {
  const trip = {
    ...MK_260615_006,
    id: "trip-mk-624",
    trip_code: "MK-260624-001",
    final_fare_pence: 849,
    outstanding_balance_pence: 0,
    payment_coverage_status: "captured",
  };
  const context = buildTripFinancialAuditContext({
    payments: [],
    payoutItems: [],
    ledgerRows: [],
    paymentSessions: [
      { id: "ps-a", trip_id: "trip-mk-624", status: "captured", captured_amount_pence: 400 },
      { id: "ps-b", trip_id: "trip-mk-624", status: "captured", captured_amount_pence: 449 },
    ],
  });
  const row = mapTripToFinancialAuditRow(trip, context);
  assertEquals(row.settlement_total_pence, 849);
  assertEquals(row.captured_pence, 849);
  assertEquals(row.outstanding_pence, 0);
  assertEquals(row.capture_mismatch, false);
});

Deno.test("Financial Reconciliation audit: debt recovery from ledger, not capture mismatch", () => {
  const trip = {
    ...MK_260615_006,
    id: "trip-mk-624-003",
    trip_code: "MK-260624-003",
    driver_net_pence: 1150,
    capture_amount_pence: 1353,
    commission_pence: 203,
  };
  const context = buildTripFinancialAuditContext({
    payments: [],
    payoutItems: [],
    ledgerRows: [
      { related_trip_id: "trip-mk-624-003", type: "TRIP_EARNING_NET", amount_pence: 1150 },
      { related_trip_id: "trip-mk-624-003", type: "DEBT_RECOVERY", amount_pence: -75 },
      { related_trip_id: "trip-mk-624-003", type: "COMMISSION_RECOVERED", amount_pence: 75 },
    ],
    paymentSessions: [{ id: "ps-624-003", trip_id: "trip-mk-624-003", status: "captured", captured_amount_pence: 1353 }],
  });
  const row = mapTripToFinancialAuditRow(trip, context);
  assertEquals(row.driver_net_pence, 1150);
  assertEquals(row.debt_recovered_pence, 75);
  assertEquals(row.available_payout_created_pence, 1075);
  assertEquals(row.capture_mismatch, false);
});

Deno.test("Financial Reconciliation audit: no debt recovery shows zero, not blank", () => {
  const context = buildTripFinancialAuditContext({
    payments: [],
    payoutItems: [],
    ledgerRows: [
      { related_trip_id: "trip-006", type: "TRIP_EARNING_NET", amount_pence: 435 },
    ],
    paymentSessions: [{ id: "ps-006", trip_id: "trip-006", status: "captured", captured_amount_pence: 512 }],
  });
  const row = mapTripToFinancialAuditRow(MK_260615_006, context);
  assertEquals(row.debt_recovered_pence, 0);
  assertEquals(row.available_payout_created_pence, 435);
});

Deno.test("Financial Reconciliation audit: full debt recovery — available payout zero", () => {
  const trip = {
    ...MK_260615_006,
    id: "trip-full-debt",
    driver_net_pence: 500,
  };
  const context = buildTripFinancialAuditContext({
    payments: [],
    payoutItems: [],
    ledgerRows: [
      { related_trip_id: "trip-full-debt", type: "TRIP_EARNING_NET", amount_pence: 500 },
      { related_trip_id: "trip-full-debt", type: "DEBT_RECOVERY", amount_pence: -500 },
    ],
    paymentSessions: [{ id: "ps-full", trip_id: "trip-full-debt", status: "captured", captured_amount_pence: 600 }],
  });
  const row = mapTripToFinancialAuditRow(trip, context);
  assertEquals(row.debt_recovered_pence, 500);
  assertEquals(row.available_payout_created_pence, 0);
});

Deno.test("FR audit: Payment Sessions capture wins over trips.capture_amount_pence=0", () => {
  const trip = {
    ...MK_260615_006,
    id: "ff155f09",
    trip_code: "MK-260709-010",
    capture_amount_pence: 0,
    final_fare_pence: 480,
    gross_fare_pence: 480,
    commission_pence: 72,
    driver_net_pence: 408,
  };
  const context = buildTripFinancialAuditContext({
    payments: [],
    payoutItems: [],
    ledgerRows: [
      { related_trip_id: "ff155f09", type: "TRIP_EARNING_NET", amount_pence: 408 },
    ],
    paymentSessions: [{
      id: "ps-mk-010",
      trip_id: "ff155f09",
      captured_amount_pence: 480,
      authorised_amount_pence: 780,
      total_authorised_amount_pence: 780,
      released_amount_pence: 300,
      refunded_amount_pence: 0,
      provider_processing_fee_pence: 25,
      fee_status: "ACTUAL",
      provider_state: "CAPTURED",
      provider_state_verified_at: new Date().toISOString(),
      status: "captured",
    }],
  });
  const row = mapTripToFinancialAuditRow(trip, context);
  assertEquals(row.captured_pence, 480);
  assertEquals(row.customer_paid_pence, 480);
  assertEquals(row.authorised_pence, 780);
  assertEquals(row.released_pence, 300);
  assertEquals(row.processing_fee_pence, 25);
  assertEquals(row.fee_status, "CONFIRMED");
  assertEquals(row.payment_session_id, "ps-mk-010");
  assertEquals(row.payment_evidence_status, "PAYMENT_SESSIONS");
  assertEquals(row.final_customer_fare_pence, 480);
  assertEquals(row.capture_variance_pence, 0);
  assertEquals(row.capture_reconciliation_status, "MATCHED");
  assertEquals(row.wallet_credit_pence, 408);
  assertEquals(row.wallet_variance_pence, 0);
  assertEquals(row.wallet_reconciliation_status, "WALLET_MATCHED");
  assertEquals(row.provider_state, "CAPTURED");
  assertEquals(row.provider_verification_status, "VERIFIED");
  assertEquals(row.onecab_net_pence, 47); // 72 gross - 25 fee
  assertEquals(row.reconciliation_status?.label, "Balanced");
  assertEquals(row.reconciliation_status?.tone, "green");
});

Deno.test("FR audit: PS captured £0 stays RED PAYMENT_SESSION_CAPTURE_MISMATCH", () => {
  const trip = {
    ...MK_260615_006,
    id: "ff155f09-bad",
    trip_code: "MK-260709-010",
    capture_amount_pence: 480,
    final_fare_pence: 480,
    commission_pence: 72,
    driver_net_pence: 408,
  };
  const context = buildTripFinancialAuditContext({
    payments: [],
    payoutItems: [],
    ledgerRows: [],
    paymentSessions: [{
      id: "ps-mk-010-bad",
      trip_id: "ff155f09-bad",
      captured_amount_pence: 0,
      authorised_amount_pence: 780,
      provider_processing_fee_pence: 25,
      status: "authorised",
    }],
  });
  const row = mapTripToFinancialAuditRow(trip, context);
  assertEquals(row.captured_pence, null);
  assertEquals(row.capture_reconciliation_status, "PAYMENT_SESSION_CAPTURE_MISMATCH");
  assertEquals(row.reconciliation_status?.tone, "red");
  assertEquals(row.reconciliation_status?.label, "PAYMENT_SESSION_CAPTURE_MISMATCH");
});

Deno.test("FR audit: never invents capture from trips.capture_amount_pence", () => {
  const trip = {
    ...MK_260615_006,
    capture_amount_pence: 780,
  };
  const context = buildTripFinancialAuditContext({
    payments: [],
    payoutItems: [],
    ledgerRows: [],
    paymentSessions: [],
  });
  const row = mapTripToFinancialAuditRow(trip, context);
  assertEquals(row.captured_pence, null);
  assertEquals(row.customer_paid_pence, null);
  assertEquals(row.authorised_pence, null);
  assertEquals(row.payment_evidence_status, "NO_PAYMENT_SESSION");
  assertEquals(row.capture_mismatch, true);
});

Deno.test("FR audit: legacy payments amounts never invent capture", () => {
  const context = buildTripFinancialAuditContext({
    payments: [{
      trip_id: "trip-006",
      status: "captured",
      provider_status: "available",
      captured_amount_pence: 9999,
    }],
    payoutItems: [],
    ledgerRows: [],
    paymentSessions: [],
  });
  const row = mapTripToFinancialAuditRow(MK_260615_006, context);
  assertEquals(row.captured_pence, null);
  assertEquals(row.customer_paid_pence, null);
});

Deno.test("FR audit: sessions map present with missing fee stays PENDING not zero", () => {
  const context = buildTripFinancialAuditContext({
    payments: [],
    payoutItems: [],
    ledgerRows: [],
    paymentSessions: [{
      id: "ps-fee",
      trip_id: "trip-006",
      status: "captured",
      captured_amount_pence: 512,
      provider_processing_fee_pence: null,
    }],
  });
  const row = mapTripToFinancialAuditRow({
    ...MK_260615_006,
    stripe_processing_fee_pence: 99,
    provider_fee_pence: 99,
  }, context);
  assertEquals(row.processing_fee_pence, null);
  assertEquals(row.fee_status, "PENDING_PROVIDER_FEE");
});
