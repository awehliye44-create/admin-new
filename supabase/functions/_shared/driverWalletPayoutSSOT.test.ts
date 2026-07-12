/**
 * Driver Wallet Payout SSOT tests — cashout eligibility + Connect audit (not FR Drivers BALANCED).
 * FR Drivers tab status is covered by frDriverReconciliationSSOT.test.ts.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeAvailableCashOutPence,
  computeCashoutLimitPence,
  computeDriverWalletPayoutSnapshot,
  computeManualBankAvailablePence,
} from "./driverWalletPayoutSSOT.ts";

Deno.test("cashout limit is zero when Stripe instant is zero even if wallet owed", () => {
  assertEquals(
    computeCashoutLimitPence({
      wallet_owed_pence: 973,
      finance_cleared_pence: 973,
      stripe_instant_available_pence: 0,
      recovery_debt_pence: 0,
    }),
    0,
  );
});

Deno.test("Revolut manual bank available uses finance-cleared wallet — never Connect", () => {
  assertEquals(
    computeManualBankAvailablePence({
      wallet_owed_pence: 986,
      finance_cleared_pence: 986,
      recovery_debt_pence: 0,
    }),
    986,
  );
  const snap = computeDriverWalletPayoutSnapshot({
    wallet_balance_pence: 986,
    finance_cleared_pence: 986,
    included_in_payout_batch_pence: 0,
    stripe_connect_available_pence: 0,
    stripe_connect_pending_pence: 0,
    stripe_paid_out_total_pence: 0,
    recovery_debt_pence: 0,
    payout_provider: "revolut",
  });
  assertEquals(snap.cashout_limit_pence, 986);
  assertEquals(snap.wallet_balance_pence, 986);
  assertEquals(snap.provider_connect_audit_status, "NOT_APPLICABLE");
});

Deno.test("Revolut available is zero when finance not cleared — with live wallet still positive", () => {
  const snap = computeDriverWalletPayoutSnapshot({
    wallet_balance_pence: 986,
    finance_cleared_pence: 0,
    included_in_payout_batch_pence: 0,
    stripe_connect_available_pence: 0,
    stripe_connect_pending_pence: 0,
    stripe_paid_out_total_pence: 0,
    recovery_debt_pence: 0,
    payout_provider: "revolut",
  });
  assertEquals(snap.wallet_balance_pence, 986);
  assertEquals(snap.cashout_limit_pence, 0);
});

Deno.test("Revolut ignores Stripe local_only mismatch freeze", () => {
  const snap = computeDriverWalletPayoutSnapshot({
    wallet_balance_pence: 408,
    finance_cleared_pence: 408,
    included_in_payout_batch_pence: 0,
    stripe_connect_available_pence: 0,
    stripe_connect_pending_pence: 0,
    stripe_paid_out_total_pence: 0,
    recovery_debt_pence: 0,
    local_only_failed_payout_pence: 408,
    payout_provider: "revolut",
  });
  assertEquals(snap.cashout_limit_pence, 408);
  assertEquals(snap.provider_connect_audit_status, "NOT_APPLICABLE");
  assertEquals(snap.payout_blocked, false);
});

Deno.test("scheduled payout display only from batch amount not wallet", () => {
  const snap = computeDriverWalletPayoutSnapshot({
    wallet_balance_pence: 973,
    finance_cleared_pence: 973,
    included_in_payout_batch_pence: 0,
    stripe_connect_available_pence: 0,
    stripe_connect_pending_pence: 0,
    stripe_paid_out_total_pence: 0,
    recovery_debt_pence: 0,
  });
  assertEquals(snap.scheduled_payout_display_pence, null);
  assertEquals(snap.current_onecab_wallet_owed_pence, 973);
});

Deno.test("available cash out ignores wallet balance — Stripe after settlement rules only", () => {
  assertEquals(
    computeAvailableCashOutPence({
      stripe_connect_available_pence: 500,
      stripe_instant_available_pence: 500,
      finance_cleared_pence: 400,
      recovery_debt_pence: 50,
    }),
    350,
  );
  assertEquals(
    computeAvailableCashOutPence({
      stripe_connect_available_pence: 200,
      stripe_instant_available_pence: 200,
      finance_cleared_pence: 973,
      recovery_debt_pence: 0,
    }),
    200,
  );
});

Deno.test("local_only failed flags Connect audit LOCAL_ONLY and freezes Stripe cashout", () => {
  const snap = computeDriverWalletPayoutSnapshot({
    wallet_balance_pence: 973,
    finance_cleared_pence: 973,
    included_in_payout_batch_pence: 0,
    stripe_connect_available_pence: 0,
    stripe_connect_pending_pence: 0,
    stripe_paid_out_total_pence: 0,
    recovery_debt_pence: 0,
    local_only_failed_payout_pence: 973,
  });
  assertEquals(snap.provider_connect_audit_status, "LOCAL_ONLY");
  assertEquals(snap.payout_blocked, true);
  assertEquals(snap.cashout_limit_pence, 0);
});

Deno.test("wallet not equal to Connect balance is Connect-OK — never FR BALANCED by itself", () => {
  const snap = computeDriverWalletPayoutSnapshot({
    wallet_balance_pence: 9_730,
    finance_cleared_pence: 9_730,
    included_in_payout_batch_pence: 0,
    stripe_connect_available_pence: 408,
    stripe_connect_pending_pence: 0,
    stripe_paid_out_total_pence: 0,
    recovery_debt_pence: 0,
  });
  // Connect audit may be OK (reference differs from wallet by design).
  assertEquals(snap.provider_connect_audit_status, "OK");
  assertEquals(snap.stripe_connect_available_pence, 408);
  assertEquals(snap.wallet_balance_pence, 9_730);
  // Legacy field is Connect audit only — FR Drivers must use frDriverReconciliationSSOT.
  assertEquals(snap.reconciliation_status, "BALANCED");
});

Deno.test("null Connect balance stays null — never coerced to 0", () => {
  const snap = computeDriverWalletPayoutSnapshot({
    wallet_balance_pence: 1001,
    finance_cleared_pence: 1001,
    included_in_payout_batch_pence: 0,
    stripe_connect_available_pence: null,
    stripe_connect_pending_pence: null,
    stripe_paid_out_total_pence: 0,
    recovery_debt_pence: 0,
  });
  assertEquals(snap.stripe_connect_available_pence, null);
  assertEquals(snap.provider_connect_audit_status, "UNAVAILABLE");
  assertEquals(snap.reconciliation_status, "PROVIDER_BALANCE_UNAVAILABLE");
});

Deno.test("mismatch freezes automatic payout and cash-out", () => {
  const snap = computeDriverWalletPayoutSnapshot({
    wallet_balance_pence: 500,
    finance_cleared_pence: 500,
    included_in_payout_batch_pence: 0,
    stripe_connect_available_pence: 500,
    stripe_connect_pending_pence: 0,
    stripe_connect_instant_available_pence: 500,
    stripe_paid_out_total_pence: 0,
    recovery_debt_pence: 0,
    ledger_debit_without_stripe_payout_pence: 100,
  });
  assertEquals(snap.provider_connect_audit_status, "MISMATCH");
  assertEquals(snap.payout_blocked, true);
  assertEquals(snap.cashout_limit_pence, 0);
});
