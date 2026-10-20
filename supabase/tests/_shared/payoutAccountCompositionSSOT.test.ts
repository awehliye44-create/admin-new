/**
 * deno test --allow-read supabase/tests/_shared/payoutAccountCompositionSSOT.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeUnbackedWalletBalance,
  resolvePayoutAccountComposition,
} from "../../functions/_shared/payoutAccountCompositionSSOT.ts";
import { PAYOUT_ELIGIBILITY_STATUS } from "../../functions/_shared/driverPayoutEligibilitySSOT.ts";

const ACTIVE = {
  deleted: false,
  driver_status: "active",
  approved: true,
  operational_paused: false,
  global_payouts_enabled: true,
  verified_destination: true,
  gate_allowed: true,
};

Deno.test("mid-payout: ACTIVE reservation covering allocated funds is Reserved not Unbacked", () => {
  const c = resolvePayoutAccountComposition({
    sql: {
      live_balance_pence: 1829,
      available_balance_pence: 0,
      pending_balance_pence: 0,
      withdrawal_in_progress_pence: 525,
      outstanding_debt_pence: 0,
    },
    eligibility: {
      eligible_entries: [
        { ledger_entry_id: "015", trip_id: "t015", amount_pence: 439, eligibility_status: PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE, des_companion_missing: true },
        { ledger_entry_id: "017", trip_id: "t017", amount_pence: 435, eligibility_status: PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE, des_companion_missing: true },
        { ledger_entry_id: "0923", trip_id: "t0923", amount_pence: 430, eligibility_status: PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE, des_companion_missing: true },
      ],
      held_entries: [
        { ledger_entry_id: "014n", trip_id: "t014", amount_pence: 425, hold_reason: "PAYOUT_ALLOCATED" },
        { ledger_entry_id: "014t", trip_id: "t014", amount_pence: 100, hold_reason: "PAYOUT_ALLOCATED" },
      ],
    },
    driver: ACTIVE,
    admin_credit_ledger_ids: new Set(),
    unrecorded_cashout_fee_pence: 0,
  });
  assertEquals(c.live_pence, 1829);
  assertEquals(c.reserved_pence, 525);
  assertEquals(c.unbacked_pence, 0);
  assertEquals(c.available_pence + c.pending_pence + c.reserved_pence + c.held_pence + c.unbacked_pence, 1829);
});

Deno.test("without reservation, allocated-but-not-debited slice appears as Unbacked", () => {
  const u = computeUnbackedWalletBalance({
    live_pence: 1829,
    eligibility: {
      eligible_entries: [
        { ledger_entry_id: "015", trip_id: null, amount_pence: 439, eligibility_status: PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE, des_companion_missing: true },
        { ledger_entry_id: "017", trip_id: null, amount_pence: 435, eligibility_status: PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE, des_companion_missing: true },
        { ledger_entry_id: "0923", trip_id: null, amount_pence: 430, eligibility_status: PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE, des_companion_missing: true },
      ],
      held_entries: [
        { ledger_entry_id: "014", trip_id: null, amount_pence: 525, hold_reason: "PAYOUT_ALLOCATED" },
      ],
    },
    withdrawal_in_progress_pence: 0,
    unrecorded_cashout_fee_pence: 0,
  });
  assertEquals(u.unbacked_pence, 525);
  assertEquals(u.unbacked_reason, "UNBACKED_WALLET_BALANCE");
});
