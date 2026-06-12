import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  allocateProviderBalanceByLiability,
  perDriverAvailableNowPence,
  perDriverRemainingLiabilityPence,
} from "./financialReconciliationSSOT.ts";
import {
  computePerDriverSSOT,
  sumCompletedEarlyCashoutsPence,
  sumInFlightCashoutPence,
} from "./perDriverFinancialReconciliation.ts";

Deno.test("per-driver liability subtracts bank payouts and completed early cashouts", () => {
  const remaining = perDriverRemainingLiabilityPence({
    driverNetEarningsPence: 10_000,
    bankPaidOutPence: 4_116,
    completedEarlyCashoutsPence: 500,
    adjustmentsPence: 0,
  });
  assertEquals(remaining, 5_384);
});

Deno.test("provider balance allocated proportionally by liability", () => {
  const allocations = allocateProviderBalanceByLiability({
    providerAvailableBalancePence: 1000,
    driverLiabilities: { a: 600, b: 400 },
  });
  assertEquals(allocations.a, 600);
  assertEquals(allocations.b, 400);
});

Deno.test("single driver receives full provider available balance", () => {
  const allocations = allocateProviderBalanceByLiability({
    providerAvailableBalancePence: 92,
    driverLiabilities: { solo: 4208 },
  });
  assertEquals(allocations.solo, 92);
});

Deno.test("available now uses allocation not wallet balance", () => {
  const available = perDriverAvailableNowPence({
    driverRemainingLiabilityPence: 4208,
    providerAllocatedBalancePence: 92,
    inFlightCashoutPence: 0,
  });
  assertEquals(available, 92);
});

Deno.test("in-flight cashout reduces available now", () => {
  const available = perDriverAvailableNowPence({
    driverRemainingLiabilityPence: 5000,
    providerAllocatedBalancePence: 5000,
    inFlightCashoutPence: 500,
  });
  assertEquals(available, 4500);
});

Deno.test("computePerDriverSSOT caps available by allocated provider balance", () => {
  const ssot = computePerDriverSSOT({
    driverId: "d1",
    trips: [{
      driver_net_pence: 5000,
      commission_pence: 500,
      gross_fare_pence: 5500,
      stripe_processing_fee_pence: 0,
      onecab_net_pence: 500,
      final_fare_pence: 5500,
      commissionable_fare_pence: 5000,
      capture_amount_pence: 5500,
    }],
    ledger: [],
    earlyCashouts: [],
    payments: [],
    providerAvailableBalancePence: 100,
    providerPendingBalancePence: 0,
    providerAllocations: { d1: 100 },
    ledgerSyncMissing: false,
  });
  assertEquals(ssot.driver_available_now_pence, 100);
  assertEquals(ssot.driver_remaining_liability_pence, 5000);
});

Deno.test("computePerDriverSSOT blocks payout when ledger sync missing", () => {
  const ssot = computePerDriverSSOT({
    driverId: "d1",
    trips: [],
    ledger: [],
    earlyCashouts: [],
    payments: [],
    providerAvailableBalancePence: 5000,
    providerPendingBalancePence: 0,
    providerAllocations: { d1: 5000 },
    ledgerSyncMissing: true,
  });
  assertEquals(ssot.payout_blocked, true);
  assertEquals(ssot.payout_blocked_reasons.some((r) => r.includes("Ledger sync")), true);
});

Deno.test("early cashout sums", () => {
  const rows = [
    { status: "paid", requested_cashout_pence: 200 },
    { status: "processing", requested_cashout_pence: 119 },
    { status: "failed", requested_cashout_pence: 50 },
  ];
  assertEquals(sumCompletedEarlyCashoutsPence(rows), 200);
  assertEquals(sumInFlightCashoutPence(rows), 119);
});
