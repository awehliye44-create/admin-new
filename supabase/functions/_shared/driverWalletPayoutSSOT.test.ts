import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeCashoutLimitPence,
  computeDriverWalletPayoutSnapshot,
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

Deno.test("local_only failed flags mismatch classification", () => {
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
  assertEquals(snap.reconciliation_status, "LOCAL_ONLY");
});
