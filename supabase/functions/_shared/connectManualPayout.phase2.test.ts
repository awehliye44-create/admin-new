import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeMaxManualConnectPayoutPence,
  evaluateConnectManualPayoutGate,
} from "./connectManualPayout.ts";

const baseInput = {
  wallet_balance_pence: 973,
  driver_available_now_pence: 45,
  connect_available_pence: 1449,
  connect_instant_available_pence: 45,
  payouts_enabled: true,
  charges_enabled: true,
  stripe_account_id: "acct_test",
  account_restricted: false,
  payout_blocked: false,
  reconciliation_status: "BALANCED",
  outstanding_debt_pence: 0,
};

Deno.test("Phase 2: manual connect cap ignores wallet liability", () => {
  assertEquals(computeMaxManualConnectPayoutPence(baseInput), 45);
  assertEquals(
    computeMaxManualConnectPayoutPence({
      ...baseInput,
      wallet_balance_pence: 50_000,
      driver_available_now_pence: 500,
      connect_instant_available_pence: 300,
    }),
    300,
  );
});

Deno.test("Phase 2: wallet 973 does not enable manual connect payout without finance-cleared", () => {
  const gate = evaluateConnectManualPayoutGate({
    ...baseInput,
    driver_available_now_pence: 0,
    connect_instant_available_pence: 973,
  });
  assertEquals(gate.allowed, false);
  assertEquals(gate.max_manual_payout_pence, 0);
});
