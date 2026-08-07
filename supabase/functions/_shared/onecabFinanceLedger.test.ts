import {
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  computeCashCommissionOutstanding,
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
});

Deno.test("positive wallet — debt fully recovered shows zero owed", () => {
  const ledger = [
    { type: "CASH_COMMISSION_DEBT", amount_pence: -500 },
    { type: "DEBT_RECOVERY", amount_pence: -500 },
    { type: "COMMISSION_RECOVERED", amount_pence: 500 },
    { type: "TRIP_EARNING_NET", amount_pence: 2000 },
  ];
  assertEquals(computeOwedToOnecab(ledger), 0);
});

Deno.test("payout eligibility — destination present but verification failed", () => {
  const result = derivePayoutEligibility({
    payout_destination_active: true,
    provider_counterparty_id: "cp_1",
    payouts_enabled: true,
    verification_status: "failed",
  });
  assertEquals(result.payout_destination_ready, true);
  assertEquals(result.stripe_connected, true);
  assertEquals(result.payout_eligible, false);
  assertEquals(result.settlement_status, "needs_attention");
});

Deno.test("payout eligibility — fully eligible via Revolut destination", () => {
  const result = derivePayoutEligibility({
    payout_destination_active: true,
    provider_counterparty_id: "cp_1",
    payouts_enabled: true,
    verification_status: "verified",
  });
  assertEquals(result.payout_destination_ready, true);
  assertEquals(result.payout_eligible, true);
  assertEquals(result.settlement_status, "eligible");
});

Deno.test("payout eligibility — stripe_account_id alone does not qualify", () => {
  const result = derivePayoutEligibility({
    stripe_account_id: "acct_1",
    onboarding_complete: true,
    payouts_enabled: true,
  });
  assertEquals(result.payout_destination_ready, false);
  assertEquals(result.payout_eligible, false);
  assertEquals(result.settlement_status, "not_connected");
});
