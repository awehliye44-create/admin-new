/**
 * LOCK — Payout Ledger and Driver Wallet Ledger explain the same live balance.
 *
 * - Live = Available + Pending + Reserved + Held + Unbacked, every row.
 * - Available is the reservation formula (SQL), never the TS projection.
 * - Unrecorded early cash-out fees surface as typed unbacked balance, never as
 *   driver earnings, never as PAYOUT_ALLOCATED, and are never payable.
 * - Deleted / held drivers show their liability as held for review: no
 *   Available, no eligible entries, no Next Scheduled.
 * - A calendar slot is only shown when the next run would pay the driver.
 * - DRIVER_CREDIT_UNKNOWN stays UNKNOWN (never OK); the reason separates an
 *   empty period from a genuine evidence gap.
 * - Paid Today / Week / Month use Europe/London boundaries.
 *
 * Fixtures are the production figures from the 14 Oct 2026 read-only audit.
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  computeUnbackedWalletBalance,
  londonPaidPeriodStarts,
  loadUnrecordedCashoutFeePenceByDriver,
  payoutAccountNotScheduledNote,
  type PayoutAccountComposition,
  type PayoutAccountDriverState,
  resolvePayoutAccountComposition,
} from "../../functions/_shared/payoutAccountCompositionSSOT.ts";
import { computeFrDriverReconciliation } from "../../functions/_shared/frDriverReconciliationSSOT.ts";
import { shouldShowDriverFinancialReviewRepair } from "../../functions/_shared/driverFinancialReviewRepairSSOT.ts";

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));

const ACTIVE: PayoutAccountDriverState = {
  deleted: false,
  driver_status: "active",
  approved: true,
  operational_paused: false,
  global_payouts_enabled: true,
  verified_destination: true,
  gate_allowed: true,
};

const NO_ADMIN_CREDITS = new Set<string>();

function assertIdentity(c: PayoutAccountComposition) {
  assertEquals(
    c.available_pence + c.pending_pence + c.reserved_pence + c.held_pence + c.unbacked_pence,
    c.live_pence,
    "Live = Available + Pending + Reserved + Held + Unbacked",
  );
}

const paid = (id: string, amount: number) => ({
  ledger_entry_id: id,
  trip_id: `t-${id}`,
  amount_pence: amount,
  hold_reason: "PAYOUT_ALLOCATED" as const,
});

Deno.test("MK0006: £5.80 live = £4.30 payable + £1.50 unrecorded cash-out fees", () => {
  const c = resolvePayoutAccountComposition({
    sql: {
      live_balance_pence: 580,
      available_balance_pence: 430,
      pending_balance_pence: 0,
      withdrawal_in_progress_pence: 0,
      outstanding_debt_pence: 0,
    },
    eligibility: {
      eligible_entries: [
        { ledger_entry_id: "mk260923017", trip_id: "t", amount_pence: 430, eligibility_status: "ELIGIBLE", des_companion_missing: true },
      ],
      held_entries: [paid("a", 425), paid("b", 595)],
    },
    driver: ACTIVE,
    admin_credit_ledger_ids: NO_ADMIN_CREDITS,
    unrecorded_cashout_fee_pence: 150,
  });
  assertEquals(c.available_pence, 430);
  assertEquals(c.unbacked_pence, 150);
  assertEquals(c.unbacked_reason, "CASHOUT_FEE_NOT_RECORDED");
  assertEquals(c.held_pence, 0);
  assertEquals(c.hold_reason, null);
  assertEquals(c.payout_included, true);
  assertEquals(c.eligible_entry_count, 1);
  assertEquals(c.status, "ELIGIBLE");
  assertIdentity(c);
});

Deno.test("MK0007: £0.50 residue is CASHOUT_FEE_NOT_RECORDED, never PAYOUT_ALLOCATED", () => {
  const c = resolvePayoutAccountComposition({
    sql: {
      live_balance_pence: 50,
      available_balance_pence: 0,
      pending_balance_pence: 0,
      withdrawal_in_progress_pence: 0,
      outstanding_debt_pence: 0,
    },
    eligibility: {
      eligible_entries: [],
      held_entries: [paid("e1", 435), paid("e2", 100), paid("e3", 435)],
    },
    driver: ACTIVE,
    admin_credit_ledger_ids: NO_ADMIN_CREDITS,
    unrecorded_cashout_fee_pence: 50,
  });
  assertEquals(c.unbacked_pence, 50);
  assertEquals(c.hold_reason, "CASHOUT_FEE_NOT_RECORDED");
  assert(c.hold_reason !== "PAYOUT_ALLOCATED");
  assertEquals(c.available_pence, 0);
  assertEquals(c.payout_included, false);
  assertEquals(c.held_entry_count, 0);
  assertEquals(c.status, "HELD");
  assertIdentity(c);
});

Deno.test("MK0003: deleted driver's 1p admin credit is held for review, never scheduled", () => {
  const c = resolvePayoutAccountComposition({
    sql: {
      live_balance_pence: 1,
      available_balance_pence: 0,
      pending_balance_pence: 0,
      withdrawal_in_progress_pence: 0,
      outstanding_debt_pence: 0,
    },
    eligibility: {
      eligible_entries: [
        { ledger_entry_id: "admin-1", trip_id: null, amount_pence: 1, eligibility_status: "ELIGIBLE", des_companion_missing: true },
      ],
      held_entries: [],
    },
    driver: { ...ACTIVE, deleted: true, driver_status: "deleted", verified_destination: false, gate_allowed: false },
    admin_credit_ledger_ids: new Set(["admin-1"]),
    unrecorded_cashout_fee_pence: 0,
  });
  assertEquals(c.live_pence, 1, "liability stays visible");
  assertEquals(c.available_pence, 0);
  assertEquals(c.held_pence, 1);
  assertEquals(c.unbacked_pence, 0);
  assertEquals(c.hold_reason, "DELETED_DRIVER_REVIEW");
  assertEquals(c.status, "HELD_REVIEW");
  assertEquals(c.payout_included, false);
  assertEquals(c.eligible_entry_count, 0);
  assertEquals(c.held_entry_count, 1);
  assertStringIncludes(payoutAccountNotScheduledNote(c.hold_reason), "deleted driver, review required");
  assertIdentity(c);
});

Deno.test("Deleted driver with SQL-available earnings: Available moves to Held, gate ignored", () => {
  const c = resolvePayoutAccountComposition({
    sql: {
      live_balance_pence: 900,
      available_balance_pence: 900,
      pending_balance_pence: 0,
      withdrawal_in_progress_pence: 0,
      outstanding_debt_pence: 0,
    },
    eligibility: {
      eligible_entries: [
        { ledger_entry_id: "e", trip_id: "t", amount_pence: 900, eligibility_status: "ELIGIBLE", des_companion_missing: false },
      ],
      held_entries: [],
    },
    driver: { ...ACTIVE, deleted: true, gate_allowed: true },
    admin_credit_ledger_ids: NO_ADMIN_CREDITS,
    unrecorded_cashout_fee_pence: 0,
  });
  assertEquals(c.available_pence, 0);
  assertEquals(c.held_pence, 900);
  assertEquals(c.payout_included, false);
  assertIdentity(c);
});

Deno.test("Mid-payout: allocated entries under an ACTIVE reservation are Reserved, not unbacked", () => {
  const c = resolvePayoutAccountComposition({
    sql: {
      live_balance_pence: 1000,
      available_balance_pence: 0,
      pending_balance_pence: 0,
      withdrawal_in_progress_pence: 1000,
      outstanding_debt_pence: 0,
    },
    eligibility: { eligible_entries: [], held_entries: [paid("r1", 600), paid("r2", 400)] },
    driver: ACTIVE,
    admin_credit_ledger_ids: NO_ADMIN_CREDITS,
    unrecorded_cashout_fee_pence: 0,
  });
  assertEquals(c.reserved_pence, 1000);
  assertEquals(c.unbacked_pence, 0);
  assertEquals(c.held_pence, 0);
  assertIdentity(c);
});

Deno.test("Unbacked balance that is not exactly the unrecorded fees needs review", () => {
  const u = computeUnbackedWalletBalance({
    live_pence: 80,
    eligibility: { eligible_entries: [], held_entries: [] },
    withdrawal_in_progress_pence: 0,
    unrecorded_cashout_fee_pence: 50,
  });
  assertEquals(u.unbacked_pence, 80);
  assertEquals(u.unbacked_reason, "UNBACKED_WALLET_BALANCE");
});

Deno.test("Paused / unverified / gate-false drivers are never in the next run", () => {
  const base = {
    sql: {
      live_balance_pence: 500,
      available_balance_pence: 500,
      pending_balance_pence: 0,
      withdrawal_in_progress_pence: 0,
      outstanding_debt_pence: 0,
    },
    eligibility: {
      eligible_entries: [
        { ledger_entry_id: "e", trip_id: "t", amount_pence: 500, eligibility_status: "ELIGIBLE" as const, des_companion_missing: false },
      ],
      held_entries: [],
    },
    admin_credit_ledger_ids: NO_ADMIN_CREDITS,
    unrecorded_cashout_fee_pence: 0,
  };
  const paused = resolvePayoutAccountComposition({ ...base, driver: { ...ACTIVE, operational_paused: true, gate_allowed: false } });
  assertEquals(paused.hold_reason, "ADMIN_HOLD");
  assertEquals(paused.status, "PAUSED");
  assertEquals(paused.payout_included, false);

  const unverified = resolvePayoutAccountComposition({ ...base, driver: { ...ACTIVE, verified_destination: false, gate_allowed: false } });
  assertEquals(unverified.hold_reason, "NO_VERIFIED_DESTINATION");
  assertEquals(unverified.payout_included, false);
  assertEquals(unverified.eligible_entry_count, 0);

  const gateOnly = resolvePayoutAccountComposition({ ...base, driver: { ...ACTIVE, gate_allowed: false } });
  assertEquals(gateOnly.payout_included, false);
});

Deno.test("Admin wallet credits are not payable through payouts (reservation formula)", () => {
  const c = resolvePayoutAccountComposition({
    sql: {
      live_balance_pence: 25,
      available_balance_pence: 0,
      pending_balance_pence: 0,
      withdrawal_in_progress_pence: 0,
      outstanding_debt_pence: 0,
    },
    eligibility: {
      eligible_entries: [
        { ledger_entry_id: "adm", trip_id: null, amount_pence: 25, eligibility_status: "ELIGIBLE", des_companion_missing: true },
      ],
      held_entries: [],
    },
    driver: ACTIVE,
    admin_credit_ledger_ids: new Set(["adm"]),
    unrecorded_cashout_fee_pence: 0,
  });
  assertEquals(c.available_pence, 0);
  assertEquals(c.held_pence, 25);
  assertEquals(c.hold_reason, "ADMIN_CREDIT_NOT_PAYABLE");
  assertEquals(c.eligible_entry_count, 0);
  assertIdentity(c);
});

Deno.test("Unrecorded fee loader sums only the fee gap per driver", async () => {
  const rows = [
    { driver_id: "mk6", fee_pence: 50, ledger_fee_pence: 0, invariant_holds: false },
    { driver_id: "mk6", fee_pence: 50, ledger_fee_pence: 0, invariant_holds: false },
    { driver_id: "mk6", fee_pence: 50, ledger_fee_pence: 0, invariant_holds: false },
    { driver_id: "mk7", fee_pence: 50, ledger_fee_pence: 0, invariant_holds: false },
    { driver_id: "mk1", fee_pence: 50, ledger_fee_pence: -50, invariant_holds: false },
  ];
  const fake = {
    from: () => ({
      select: () => ({
        in: () => ({ eq: () => Promise.resolve({ data: rows, error: null }) }),
      }),
    }),
  };
  const map = await loadUnrecordedCashoutFeePenceByDriver(fake, ["mk6", "mk7", "mk1"]);
  assertEquals(map.get("mk6"), 150);
  assertEquals(map.get("mk7"), 50);
  assertEquals(map.get("mk1"), undefined);
});

Deno.test("Paid Today / This Week / This Month use Europe/London boundaries", () => {
  // Sun 18 Oct 23:30 UTC = Mon 19 Oct 00:30 BST.
  const bst = londonPaidPeriodStarts(new Date("2026-10-18T23:30:00Z"));
  assertEquals(bst.day.toISOString(), "2026-10-18T23:00:00.000Z");
  assertEquals(bst.week.toISOString(), "2026-10-18T23:00:00.000Z");
  assertEquals(bst.month.toISOString(), "2026-09-30T23:00:00.000Z");
  // Mon 2 Nov 00:30 GMT, after the clocks change.
  const gmt = londonPaidPeriodStarts(new Date("2026-11-02T00:30:00Z"));
  assertEquals(gmt.week.toISOString(), "2026-11-02T00:00:00.000Z");
  assertEquals(gmt.month.toISOString(), "2026-11-01T00:00:00.000Z");
  // Wed 14 Oct 10:00 BST → week from Mon 12 Oct 00:00 BST.
  assertEquals(londonPaidPeriodStarts(new Date("2026-10-14T09:00:00Z")).week.toISOString(), "2026-10-11T23:00:00.000Z");
});

const frBase = {
  completedPayoutItems: [],
  walletEvidenceAvailable: true,
  settlementEvidenceAvailable: true,
  identityMappingValid: true,
  accountVerified: true,
  payout_provider: "revolut",
  finance_cleared_pence: 0,
  provider_account_balance_pence: null,
  provider_account_balance_status: "NOT_APPLICABLE" as const,
  query_scope_status: "PERIOD_SCOPED" as const,
};

Deno.test("Empty period stays DRIVER_CREDIT_UNKNOWN with reason NO_TRIPS_IN_PERIOD", () => {
  const row = computeFrDriverReconciliation({ ...frBase, ledger: [], settledTrips: [] });
  assertEquals(row.driver_credit_status, "DRIVER_CREDIT_UNKNOWN");
  assertEquals(row.driver_credit_unknown_reason, "NO_TRIPS_IN_PERIOD");
});

Deno.test("Credits without an evaluable trip stay a genuine UNKNOWN", () => {
  const row = computeFrDriverReconciliation({
    ...frBase,
    ledger: [{ type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: "x" }],
    settledTrips: [],
  });
  assertEquals(row.driver_credit_status, "DRIVER_CREDIT_UNKNOWN");
  assertEquals(row.driver_credit_unknown_reason, "CREDITS_WITHOUT_EVALUABLE_TRIP");
});

Deno.test("Evidence gaps keep their own UNKNOWN reasons", () => {
  assertEquals(
    computeFrDriverReconciliation({ ...frBase, ledger: [], settledTrips: [], identityMappingValid: false })
      .driver_credit_unknown_reason,
    "IDENTITY_MAPPING_MISSING",
  );
  assertEquals(
    computeFrDriverReconciliation({ ...frBase, ledger: [], settledTrips: [], walletEvidenceAvailable: false })
      .driver_credit_unknown_reason,
    "WALLET_EVIDENCE_UNAVAILABLE",
  );
  assertEquals(
    computeFrDriverReconciliation({ ...frBase, ledger: [], settledTrips: [], settlementEvidenceAvailable: false })
      .driver_credit_unknown_reason,
    "SETTLEMENT_EVIDENCE_UNAVAILABLE",
  );
});

Deno.test("Review & repair: an empty period alone does not open it; genuine UNKNOWN still does", () => {
  assertEquals(
    shouldShowDriverFinancialReviewRepair({
      wallet_status: "ACTIVE",
      driver_credit_status: "DRIVER_CREDIT_UNKNOWN",
      driver_credit_unknown_reason: "NO_TRIPS_IN_PERIOD",
    }),
    false,
  );
  assertEquals(
    shouldShowDriverFinancialReviewRepair({ wallet_status: "ACTIVE", driver_credit_status: "DRIVER_CREDIT_UNKNOWN" }),
    true,
  );
  assertEquals(
    shouldShowDriverFinancialReviewRepair({
      wallet_status: "ACTIVE",
      driver_credit_status: "DRIVER_CREDIT_UNKNOWN",
      driver_credit_unknown_reason: "CREDITS_WITHOUT_EVALUABLE_TRIP",
    }),
    true,
  );
  assertEquals(
    shouldShowDriverFinancialReviewRepair({
      wallet_status: "FROZEN",
      driver_credit_status: "DRIVER_CREDIT_UNKNOWN",
      driver_credit_unknown_reason: "NO_TRIPS_IN_PERIOD",
    }),
    true,
  );
});

Deno.test("Payout Ledger accounts read the reservation formula, the gate and deletion", () => {
  const src = read("../../functions/_shared/adminPayoutLedgerAccountsOverviewSSOT.ts");
  assertStringIncludes(src, "fetchDriverWalletEligibilityBalancesRpc");
  assertStringIncludes(src, '"driver_effective_payout_allowed"');
  assertStringIncludes(src, "deleted_at");
  assertStringIncludes(src, "resolvePayoutAccountComposition");
  assert(!/manualBank\s*=\s*true/.test(src), "destination must not be hard-coded");
  assert(!src.includes("setUTCHours(0, 0, 0, 0)"), "paid totals must use London bounds");
  assert(!/verification:[^\n]*"manual_bank"/.test(src), "verification must come from the real destination");
  assertStringIncludes(src, "ctx.provider_verified_active_destination");
});

Deno.test("Composition is display-only and stays off the money path", () => {
  const src = read("../../functions/_shared/payoutAccountCompositionSSOT.ts");
  for (const write of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
    assert(!src.includes(write), `composition must not call ${write}`);
  }
  for (const moneyPath of [
    "../../functions/admin-weekly-payout-scheduler/index.ts",
    "../../functions/admin-execute-weekly-payout-occurrence/index.ts",
    "../../functions/driver-withdraw/index.ts",
    "../../functions/_shared/driverPayoutEligibilitySSOT.ts",
    "../../functions/_shared/fetchDriverPayoutEligibility.ts",
  ]) {
    assert(!read(moneyPath).includes("payoutAccountCompositionSSOT"), `${moneyPath} must not use display composition`);
  }
});
