/**
 * Payout recovery regression (MK0006 / MK0002 / MK0001, Oct 2026).
 * Run: deno test --allow-read supabase/tests/_shared/payoutRecoveryRegression.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  aggregateDriverPayoutEligibility,
  type LedgerEligibilityEvidence,
} from "../../functions/_shared/driverPayoutEligibilitySSOT.ts";
import { planPayoutItemFromEligibleEntries } from "../../functions/_shared/payoutLedgerHandoffSSOT.ts";
import { resolveWeeklyPayableAmountPence } from "../../functions/_shared/weeklyPayoutPeriodSSOT.ts";
import {
  isConflictingActivePayoutItem,
  isStaleUnsubmittedWeeklyItemCandidate,
} from "../../functions/_shared/payoutItemLifecycleSSOT.ts";

const NOW_MS = Date.parse("2026-10-13T12:00:00.000Z");
const POLICY = { now_ms: NOW_MS, clearing_delay_hours: 27 };
const CLEARED = "2026-10-08T10:00:00.000Z";

function credit(id: string, pence: number, overrides: Partial<LedgerEligibilityEvidence> = {}): LedgerEligibilityEvidence {
  return {
    ledger_entry_id: id,
    trip_id: `trip-${id}`,
    ledger_type: "TRIP_EARNING_NET",
    amount_pence: pence,
    trip_exists: true,
    payment_session_id: `ps-${id}`,
    captured_amount_pence: pence + 100,
    canonical_driver_net_pence: pence,
    fr_trip_status: "BALANCED",
    refunded_amount_pence: 0,
    des_present: false,
    payment_collection_model: "PLATFORM_COLLECTED",
    payment_method: "card",
    trip_status: "completed",
    completed_at: CLEARED,
    captured_at: CLEARED,
    earning_credited_at: CLEARED,
    ...overrides,
  };
}

/** Live must be fully explained by Available + Pending + Withdrawal-in-progress + Held. */
function unexplainedLivePence(agg: ReturnType<typeof aggregateDriverPayoutEligibility>): number {
  const heldNonPending = agg.held_entries
    .filter((h) => h.hold_reason !== "SETTLEMENT_PENDING")
    .reduce((s, h) => s + h.amount_pence, 0);
  return agg.live_balance_pence
    - agg.available_balance_pence
    - agg.pending_balance_pence
    - agg.withdrawal_in_progress_pence
    - heldNonPending;
}

// MK0006 credits that matter after the last completed payout.
const MK261007_002 = credit("mk-261007-002", 484);
const MK260927_009 = credit("mk-260927-009", 376);
const MK261002_014 = credit("mk-261002-014", 426);
const MK261004_014 = credit("mk-261004-014", 425);
const MK260923_017 = credit("mk-260923-017", 430, {
  captured_amount_pence: 500,
  trip_status: "cancelled",
  trip_cancelled: true,
});

Deno.test("early cash-out fee: missing CASHOUT_FEE leaves 150p of Live unexplained", () => {
  const stuck = [MK260927_009, MK261002_014, MK261004_014].map((e) => ({
    ...e,
    allocated_amount_pence: e.amount_pence,
  }));
  const before = aggregateDriverPayoutEligibility({
    live_balance_pence: 2291,
    reserved_payout_pence: 0,
    entries: [MK261007_002, ...stuck, MK260923_017],
    clearing_policy: POLICY,
  });
  assertEquals(before.available_balance_pence, 484);
  // 1,227 allocated to the stuck 6 Oct item and 430 cancelled-trip are held;
  // the only unexplained Live is the three unrecorded 50p fees.
  assertEquals(unexplainedLivePence(before), 150);
});

Deno.test("early cash-out fee: fee never appears as Available, Pending or Held", () => {
  const after = aggregateDriverPayoutEligibility({
    live_balance_pence: 2141,
    entries: [MK261007_002, MK260927_009, MK261002_014, MK261004_014, MK260923_017],
    clearing_policy: POLICY,
  });
  assertEquals(after.available_balance_pence, 1711);
  assertEquals(after.pending_balance_pence, 0);
  assertEquals(
    after.held_entries.map((h) => [h.ledger_entry_id, h.amount_pence]),
    [["mk-260923-017", 430]],
  );
  assertEquals(unexplainedLivePence(after), 0);
});

Deno.test("early cash-out fee: gross consumed = net transfer + fee for every affected cash-out", () => {
  const cashouts = [
    { gross: 3319, net: 3269, fee: 50 },
    { gross: 1179, net: 1129, fee: 50 },
    { gross: 4555, net: 4505, fee: 50 },
    { gross: 3065, net: 3015, fee: 50 },
  ];
  for (const c of cashouts) {
    assertEquals(c.net + c.fee, c.gross);
    // Wallet debit = EARLY_CASHOUT(-net) + CASHOUT_FEE(-fee).
    assertEquals(-c.net + -c.fee, -c.gross);
  }
});

Deno.test("stale VALIDATED recovery: retiring the 6 Oct item releases exactly 1,227p", () => {
  const withStale = aggregateDriverPayoutEligibility({
    live_balance_pence: 2141,
    entries: [
      MK261007_002,
      ...[MK260927_009, MK261002_014, MK261004_014].map((e) => ({ ...e, allocated_amount_pence: e.amount_pence })),
      MK260923_017,
    ],
    clearing_policy: POLICY,
  });
  const retired = aggregateDriverPayoutEligibility({
    live_balance_pence: 2141,
    entries: [MK261007_002, MK260927_009, MK261002_014, MK261004_014, MK260923_017],
    clearing_policy: POLICY,
  });
  assertEquals(withStale.available_balance_pence, 484);
  assertEquals(retired.available_balance_pence - withStale.available_balance_pence, 1227);
});

Deno.test("duplicate prevention: MK0002 legacy-paid credits never plan a payout (Live 0)", () => {
  const legacyPaid = [425, 425, 47, 425, 382, 744, 425, 609, 706, 425, 425, 425, 526]
    .map((p, i) => credit(`mk0002-${i}`, p));
  const agg = aggregateDriverPayoutEligibility({
    live_balance_pence: 0,
    entries: legacyPaid,
    clearing_policy: POLICY,
  });
  assertEquals(agg.available_balance_pence, 0);
  assert(agg.eligible_entries.length > 0, "raw eligible entries remain uncapped");
  const scoped = agg.eligible_entries.reduce((s, e) => s + e.amount_pence, 0);
  const payable = resolveWeeklyPayableAmountPence({
    scoped_amount_pence: scoped,
    wallet_available_pence: agg.available_balance_pence,
    minimum_payout_pence: 0,
  });
  assertEquals(payable, { amount_pence: 0, blocked_reason: "NO_AVAILABLE_BALANCE" });
  assertEquals(
    planPayoutItemFromEligibleEntries({
      eligible_entries: agg.eligible_entries,
      available_balance_pence: payable.amount_pence,
    }),
    null,
  );
});

Deno.test("scheduler eligibility: weekly amount is capped by Available, allocations match", () => {
  const payable = resolveWeeklyPayableAmountPence({
    scoped_amount_pence: 1711,
    wallet_available_pence: 484,
    minimum_payout_pence: 0,
  });
  assertEquals(payable, { amount_pence: 484, blocked_reason: null });
  const plan = planPayoutItemFromEligibleEntries({
    eligible_entries: [
      { ledger_entry_id: "a", amount_pence: 376 },
      { ledger_entry_id: "b", amount_pence: 426 },
    ],
    available_balance_pence: payable.amount_pence,
  });
  assertEquals(plan?.amount_pence, 484);
  assertEquals(plan?.allocations.reduce((s, a) => s + a.amount_pence, 0), 484);
});

Deno.test("payout minimum: admin setting is authoritative (0 pays any positive balance)", () => {
  const base = { scoped_amount_pence: 1711, wallet_available_pence: 1711 };
  assertEquals(resolveWeeklyPayableAmountPence({ ...base, minimum_payout_pence: 0 }).amount_pence, 1711);
  assertEquals(resolveWeeklyPayableAmountPence({ ...base, minimum_payout_pence: 1711 }).amount_pence, 1711);
  assertEquals(
    resolveWeeklyPayableAmountPence({ ...base, minimum_payout_pence: 2000 }),
    { amount_pence: 0, blocked_reason: "BELOW_MIN_PAYOUT" },
  );
  assertEquals(
    resolveWeeklyPayableAmountPence({ scoped_amount_pence: 1, wallet_available_pence: 1, minimum_payout_pence: -5 }),
    { amount_pence: 1, blocked_reason: null },
  );
});

Deno.test("chargeable/cancelled classification: post-completion admin cancel stays held, never payable", () => {
  const agg = aggregateDriverPayoutEligibility({
    live_balance_pence: 430,
    entries: [MK260923_017],
    clearing_policy: POLICY,
  });
  assertEquals(agg.available_balance_pence, 0);
  assertEquals(agg.eligible_entries.length, 0);
  assertEquals(agg.held_entries[0]?.amount_pence, 430);
});

Deno.test("chargeable/cancelled classification: once paid (allocated), the same credit is never payable twice", () => {
  const completed = { ...MK260923_017, trip_status: "completed", trip_cancelled: false };
  const unpaid = aggregateDriverPayoutEligibility({
    live_balance_pence: 430,
    entries: [completed],
    clearing_policy: POLICY,
  });
  assertEquals(unpaid.available_balance_pence, 430);
  const paid = aggregateDriverPayoutEligibility({
    live_balance_pence: 0,
    entries: [{ ...completed, allocated_amount_pence: 430 }],
    clearing_policy: POLICY,
  });
  assertEquals(paid.available_balance_pence, 0);
  assertEquals(paid.eligible_entries.length, 0);
});

const CURRENT = "weekly-payout:milton-keynes:2026-10-13T12:00:00+01:00";

Deno.test("stale VALIDATED: earlier-occurrence never-submitted item is a retirement candidate", () => {
  assertEquals(
    isStaleUnsubmittedWeeklyItemCandidate({
      status: "VALIDATED",
      execution_status: "VALIDATED",
      batch_kind: "WEEKLY_SCHEDULED",
      batch_schedule_occurrence_key: "weekly-payout:milton-keynes:2026-10-06T12:00:00+01:00",
      current_schedule_occurrence_key: CURRENT,
    }),
    true,
  );
  assertEquals(
    isStaleUnsubmittedWeeklyItemCandidate({
      status: "BLOCKED_EXECUTION_DISABLED",
      execution_status: "BLOCKED_EXECUTION_DISABLED",
      batch_kind: "WEEKLY_SCHEDULED",
      batch_schedule_occurrence_key: null,
      current_schedule_occurrence_key: CURRENT,
    }),
    true,
  );
});

Deno.test("stale VALIDATED: anything that may have reached the wallet or provider is never retired", () => {
  const base = {
    batch_kind: "WEEKLY_SCHEDULED",
    batch_schedule_occurrence_key: "weekly-payout:milton-keynes:2026-10-06T12:00:00+01:00",
    current_schedule_occurrence_key: CURRENT,
  };
  for (const status of ["RESERVING", "RESERVED", "SUBMITTING", "SUBMITTED", "UNKNOWN", "PROVIDER_ACCEPTED", "COMPLETED"]) {
    assertEquals(isStaleUnsubmittedWeeklyItemCandidate({ ...base, status, execution_status: status }), false, status);
  }
  assertEquals(
    isStaleUnsubmittedWeeklyItemCandidate({ ...base, status: "VALIDATED", execution_status: "RESERVED" }),
    false,
  );
  for (const trace of ["provider_reference", "provider_payout_id", "provider_transfer_id", "ledger_entry_id"] as const) {
    assertEquals(
      isStaleUnsubmittedWeeklyItemCandidate({ ...base, status: "VALIDATED", [trace]: "x" }),
      false,
      trace,
    );
  }
  assertEquals(
    isStaleUnsubmittedWeeklyItemCandidate({ ...base, status: "VALIDATED", batch_kind: "EARLY_CASHOUT" }),
    false,
  );
  assertEquals(
    isStaleUnsubmittedWeeklyItemCandidate({
      ...base,
      status: "VALIDATED",
      batch_schedule_occurrence_key: CURRENT,
    }),
    false,
    "current occurrence items are resumed, not retired",
  );
});

Deno.test("partial batch: COMPLETED sibling never blocks nor re-enters the conflict gate", () => {
  assertEquals(isConflictingActivePayoutItem({ status: "COMPLETED", execution_status: "COMPLETED" }), false);
  assertEquals(isConflictingActivePayoutItem({ status: "VALIDATED", execution_status: "VALIDATED" }), true);
  assertEquals(isConflictingActivePayoutItem({ status: "CANCELLED", execution_status: "CANCELLED" }), false);
});
