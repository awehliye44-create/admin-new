import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildReconciliationCheck,
  buildTripEarningsReconciliationCheck,
  computeSSOTMetrics,
  driverRemainingLiabilityPence,
  sumCustomerRevenuePence,
} from "./financialReconciliationSSOT.ts";

Deno.test("customer revenue prefers payments over trips", () => {
  const r = sumCustomerRevenuePence({
    payments: [{ captured_amount_pence: 5000, status: "captured" }],
    trips: [{ capture_amount_pence: 3000, final_fare_pence: 3000 } as import("./financialReconciliationSSOT.ts").TripSSOTRow],
  });
  assertEquals(r.total_pence, 5000);
  assertEquals(r.source, "payments");
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
    payments: [{ captured_amount_pence: 10000, status: "paid" }],
    trips: [{
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
});
