import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildReconciliationCheck,
  buildSplitReconciliationCheck,
  buildTripEarningsReconciliationCheck,
  computePaymentMethodLedgerMetrics,
  computeSSOTMetrics,
  driverRemainingLiabilityPence,
  netPlatformRevenuePence,
  sumCustomerRevenuePence,
  totalCommissionEarnedPence,
} from "./financialReconciliationSSOT.ts";

Deno.test("customer revenue prefers payments over trips", () => {
  const r = sumCustomerRevenuePence({
    payments: [{ captured_amount_pence: 5000, status: "captured" }],
    trips: [{ capture_amount_pence: 3000, final_fare_pence: 3000 } as import("./financialReconciliationSSOT.ts").TripSSOTRow],
  });
  assertEquals(r.total_pence, 5000);
  assertEquals(r.source, "payments_captured");
});

Deno.test("cash reconciliation does not double-count adjustments", () => {
  const paidOut = 3000;
  const adjustments = 300;
  const driverNet = 8000;
  const remaining = driverNet - paidOut + adjustments;
  const check = buildReconciliationCheck({
    netCustomerRevenuePence: 10000,
    driverPaidOutPence: paidOut,
    driverRemainingLiabilityPence: remaining,
    onecabNetCommissionPence: 1500,
    providerProcessingFeePence: 200,
    adjustmentsPence: adjustments,
  });
  assertEquals(check.balanced, true);
  assertEquals(check.status, "BALANCED");
});

Deno.test("trip earnings reconciliation balances with tips", () => {
  const check = buildTripEarningsReconciliationCheck({
    netCustomerRevenuePence: 10000,
    driverNetEarningsPence: 8000,
    onecabGrossCommissionPence: 1500,
    tipsPence: 500,
  });
  assertEquals(check.balanced, true);
});

Deno.test("driver remaining liability formula", () => {
  const remaining = driverRemainingLiabilityPence({
    driverNetEarningsPence: 4208,
    driverPaidOutPence: 4116,
    adjustmentsPence: 0,
  });
  assertEquals(remaining, 92);
});

Deno.test("computeSSOTMetrics end-to-end", () => {
  const m = computeSSOTMetrics({
    payments: [{ captured_amount_pence: 10000, status: "paid", trip_id: "t1" }],
    trips: [{
      id: "t1",
      payment_method: "card",
      payment_status: "captured",
      commission_pence: 1500,
      stripe_processing_fee_pence: 200,
      driver_net_pence: 8500,
      gross_fare_pence: 10000,
      capture_amount_pence: 10000,
    } as import("./financialReconciliationSSOT.ts").TripSSOTRow],
    ledger: [{ type: "WEEKLY_PAYOUT", amount_pence: -4116 }],
    providerAvailableBalancePence: 5000,
    providerPendingBalancePence: 0,
  });
  assertEquals(m.net_customer_revenue_pence, 10000);
  assertEquals(m.onecab_gross_commission_pence, 1500);
  assertEquals(m.driver_paid_out_pence, 4116);
  assertEquals(m.ledger_split.card_driver_payable_pence, 8500);
});

Deno.test("historical legacy cash trips excluded from digital reconciliation", () => {
  const ledger = computePaymentMethodLedgerMetrics({
    trips: [{
      id: "cash1",
      payment_method: "CASH",
      commissionable_fare_pence: 840,
      commission_pence: 126,
      driver_net_pence: 714,
      gross_fare_pence: 840,
    } as import("./financialReconciliationSSOT.ts").TripSSOTRow],
  });
  assertEquals(ledger.cash_collected_by_driver_pence, 0);
  assertEquals(ledger.cash_driver_already_received_pence, 0);
  assertEquals(ledger.onecab_cash_commission_receivable_pence, 0);
  assertEquals(ledger.card_driver_payable_pence, 0);

  const check = buildSplitReconciliationCheck({ ledger });
  assertEquals(check.balanced, true);
});

Deno.test("mixed card+cash balances separately — no false mismatch from mixing", () => {
  const ledger = computePaymentMethodLedgerMetrics({
    trips: [
      {
        id: "c1",
        payment_method: "card",
        payment_status: "captured",
        commissionable_fare_pence: 5783,
        capture_amount_pence: 5783,
        commission_pence: 867,
        driver_net_pence: 4916,
        stripe_processing_fee_pence: 120,
      },
      {
        id: "cash1",
        payment_method: "CASH",
        commissionable_fare_pence: 840,
        commission_pence: 126,
        driver_net_pence: 714,
      },
    ] as import("./financialReconciliationSSOT.ts").TripSSOTRow[],
    payments: [{ trip_id: "c1", captured_amount_pence: 5783, status: "captured" }],
  });
  const check = buildSplitReconciliationCheck({ ledger });
  assertEquals(check.balanced, true);
  assertEquals(ledger.card_customer_revenue_pence, 5783);
  assertEquals(ledger.card_driver_payable_pence, 4916);
  assertEquals(ledger.onecab_card_commission_pence, 867);
});

Deno.test("total commission and net platform revenue — card + cash, Stripe fees card only", () => {
  const cardCommission = 72;
  const cashCommission = 222;
  const stripeFees = 27;
  assertEquals(totalCommissionEarnedPence(cardCommission, cashCommission), 294);
  assertEquals(netPlatformRevenuePence(294, stripeFees), 267);

  const m = computeSSOTMetrics({
    payments: [{ trip_id: "c1", captured_amount_pence: 480, status: "captured" }],
    trips: [
      {
        id: "c1",
        payment_method: "card",
        payment_status: "captured",
        commissionable_fare_pence: 480,
        capture_amount_pence: 480,
        commission_pence: 72,
        driver_net_pence: 408,
        stripe_processing_fee_pence: 27,
      },
      {
        id: "cash1",
        payment_method: "CASH",
        commissionable_fare_pence: 1481,
        commission_pence: 222,
        driver_net_pence: 1259,
        stripe_processing_fee_pence: 99,
      },
    ] as import("./financialReconciliationSSOT.ts").TripSSOTRow[],
    ledger: [],
    providerAvailableBalancePence: 0,
    providerPendingBalancePence: 0,
  });

  assertEquals(m.ledger_split.onecab_card_commission_pence, 72);
  assertEquals(m.ledger_split.onecab_cash_commission_receivable_pence, 222);
  assertEquals(m.ledger_split.stripe_processing_fees_pence, 27);
  assertEquals(m.total_commission_earned_pence, 294);
  assertEquals(m.net_platform_revenue_pence, 267);
  assertEquals(m.onecab_card_net_commission_pence, 45);
});

Deno.test("computePaymentMethodLedgerMetrics sums all payment PIs per trip (MK-260624-001)", () => {
  const ledger = computePaymentMethodLedgerMetrics({
    trips: [{
      id: "trip-mk-624",
      payment_method: "card",
      payment_status: "captured",
      capture_amount_pence: 400,
      final_fare_pence: 849,
      commission_pence: 127,
      driver_net_pence: 722,
      stripe_processing_fee_pence: 0,
    }] as import("./financialReconciliationSSOT.ts").TripSSOTRow[],
    payments: [
      { trip_id: "trip-mk-624", captured_amount_pence: 400, status: "captured" },
      { trip_id: "trip-mk-624", captured_amount_pence: 449, status: "captured" },
    ],
  });
  assertEquals(ledger.card_customer_revenue_pence, 849);
  assertEquals(ledger.net_card_revenue_pence, 849);
});

Deno.test("completed card trip without capture does not increase reconciled commission", () => {
  const m = computeSSOTMetrics({
    payments: [],
    trips: [{
      id: "pending1",
      payment_method: "card",
      payment_status: "capture_requested",
      commission_pence: 500,
      driver_net_pence: 2000,
      final_fare_pence: 2500,
    } as import("./financialReconciliationSSOT.ts").TripSSOTRow],
    ledger: [],
    providerAvailableBalancePence: 0,
    providerPendingBalancePence: 0,
  });
  assertEquals(m.onecab_gross_commission_pence, 0);
  assertEquals(m.total_customer_revenue_pence, 0);
  assertEquals(m.pending_trip_count, 1);
  assertEquals(m.pending_stripe_confirmation_commission_pence, 500);
});
