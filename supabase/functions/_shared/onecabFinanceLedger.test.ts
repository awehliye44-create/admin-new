import {
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  computeAvailableNowPence,
  computeCashCommissionOutstanding,
  computeNextWeeklyPayoutPence,
  computeOwedToOnecab,
  derivePayoutEligibility,
  isCardCaptureFailed,
  isCardPaymentCaptured,
} from "./onecabFinanceLedger.ts";

Deno.test("card capture failed — no captured status", () => {
  assertEquals(
    isCardPaymentCaptured({ tripPaymentStatus: "capture_failed", paymentStatus: "capture_failed" }),
    false,
  );
  assertEquals(isCardCaptureFailed({ paymentStatus: "capture_failed" }), true);
});

Deno.test("card captured — eligible payment statuses", () => {
  assertEquals(isCardPaymentCaptured({ paymentStatus: "captured" }), true);
  assertEquals(isCardPaymentCaptured({ tripPaymentStatus: "paid" }), true);
});

Deno.test("cash trip — commission debt without card earnings", () => {
  const ledger = [
    { type: "CASH_COMMISSION_DEBT", amount_pence: -500 },
    { type: "CASH_TRIP_EARNING", amount_pence: 2000 },
  ];
  assertEquals(computeOwedToOnecab(ledger), 500);
  assertEquals(
    computeAvailableNowPence({
      ledger,
      settledCardDriverEarningsPence: 0,
      settledCardTipsPence: 0,
      pendingCardEarningsPence: 0,
      pendingCardTipsPence: 0,
      bonusesPence: 0,
      positiveAdjustmentsPence: 0,
      negativeAdjustmentsPence: 0,
      paidOutPence: 0,
    }),
    0,
  );
});

Deno.test("cash debt recovered by card earnings — DEBT_RECOVERY reduces owed", () => {
  const ledger = [
    { type: "CASH_COMMISSION_DEBT", amount_pence: -500 },
    { type: "DEBT_RECOVERY", amount_pence: -300 },
    { type: "COMMISSION_RECOVERED", amount_pence: 300 },
    { type: "TRIP_EARNING_NET", amount_pence: 1000 },
  ];
  assertEquals(computeCashCommissionOutstanding(ledger), 200);
  assertEquals(computeOwedToOnecab(ledger), 200);
  assertEquals(
    computeAvailableNowPence({
      ledger,
      settledCardDriverEarningsPence: 1000,
      settledCardTipsPence: 0,
      pendingCardEarningsPence: 0,
      pendingCardTipsPence: 0,
      bonusesPence: 0,
      positiveAdjustmentsPence: 0,
      negativeAdjustmentsPence: 0,
      paidOutPence: 0,
    }),
    500,
  );
});

Deno.test("positive wallet — debt fully recovered shows zero owed", () => {
  const ledger = [
    { type: "CASH_COMMISSION_DEBT", amount_pence: -500 },
    { type: "DEBT_RECOVERY", amount_pence: -500 },
    { type: "COMMISSION_RECOVERED", amount_pence: 500 },
    { type: "TRIP_EARNING_NET", amount_pence: 2000 },
  ];
  assertEquals(computeOwedToOnecab(ledger), 0);
  assertEquals(
    computeAvailableNowPence({
      ledger,
      settledCardDriverEarningsPence: 2000,
      settledCardTipsPence: 0,
      pendingCardEarningsPence: 0,
      pendingCardTipsPence: 0,
      bonusesPence: 0,
      positiveAdjustmentsPence: 0,
      negativeAdjustmentsPence: 0,
      paidOutPence: 0,
    }),
    1500,
  );
});

Deno.test("next weekly payout excludes failed captures and offsets debt", () => {
  const ledger = [{ type: "CASH_COMMISSION_DEBT", amount_pence: -400 }];
  assertEquals(
    computeNextWeeklyPayoutPence({
      ledger,
      settledCardDriverEarningsPence: 0,
      settledCardTipsPence: 0,
      pendingCardEarningsPence: 600,
      pendingCardTipsPence: 100,
      bonusesPence: 0,
      positiveAdjustmentsPence: 0,
      negativeAdjustmentsPence: 0,
      paidOutPence: 0,
    }),
    300,
  );
});

Deno.test("payout eligibility — connected but missing external account", () => {
  const result = derivePayoutEligibility({
    stripe_account_id: "acct_1",
    onboarding_complete: true,
    payouts_enabled: true,
    external_account_exists: false,
    requirements_currently_due: [],
  });
  assertEquals(result.stripe_connected, true);
  assertEquals(result.payout_eligible, false);
  assertEquals(result.settlement_status, "needs_attention");
});

Deno.test("payout eligibility — fully eligible", () => {
  const result = derivePayoutEligibility({
    stripe_account_id: "acct_1",
    onboarding_complete: true,
    payouts_enabled: true,
    external_account_exists: true,
    requirements_currently_due: [],
  });
  assertEquals(result.payout_eligible, true);
  assertEquals(result.settlement_status, "eligible");
});
