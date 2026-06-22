import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  allocateProviderBalanceByLiability,
  perDriverRemainingLiabilityPence,
} from "./financialReconciliationSSOT.ts";
import {
  computePerDriverSSOT,
  sumCompletedEarlyCashoutsPence,
  sumInFlightCashoutPence,
} from "./perDriverFinancialReconciliation.ts";
import { WALLET_NEGATIVE_BLOCK_REASON } from "./payoutAvailability.ts";

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

Deno.test("SSOT: available_payout = max(walletBalance, 0) — positive wallet", () => {
  const ssot = computePerDriverSSOT({
    driverId: "d1",
    trips: [],
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 5000 },
    ],
    earlyCashouts: [],
    payments: [],
    providerAvailableBalancePence: 100,
    providerPendingBalancePence: 0,
    providerAllocations: { d1: 100 },
    ledgerSyncMissing: false,
  });
  // available is independent of provider allocation under the SSOT
  assertEquals(ssot.driver_wallet_balance_pence, 5000);
  assertEquals(ssot.driver_available_now_pence, 5000);
  assertEquals(ssot.driver_debt_pence, 0);
});

Deno.test("SSOT: wallet_balance < 0 blocks payout with explicit reason", () => {
  const ssot = computePerDriverSSOT({
    driverId: "d1",
    trips: [],
    ledger: [
      { type: "CASH_COMMISSION_DEBT", amount_pence: -1964 },
    ],
    earlyCashouts: [],
    payments: [],
    providerAvailableBalancePence: 5000,
    providerPendingBalancePence: 0,
    providerAllocations: { d1: 5000 },
    ledgerSyncMissing: false,
  });
  assertEquals(ssot.driver_wallet_balance_pence, -1964);
  assertEquals(ssot.driver_available_now_pence, 0);
  assertEquals(ssot.driver_debt_pence, 1964);
  assertEquals(ssot.payout_blocked, true);
  assertEquals(ssot.payout_blocked_reasons.includes(WALLET_NEGATIVE_BLOCK_REASON), true);
});

Deno.test("computePerDriverSSOT blocks payout when ledger sync missing", () => {
  const ssot = computePerDriverSSOT({
    driverId: "d1",
    trips: [],
    ledger: [{ type: "TRIP_EARNING_NET", amount_pence: 5000 }],
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
