/**
 * Lock: weekly payout pays the previous completed Europe/London calendar week only.
 *
 *   deno test --allow-read supabase/tests/_shared/weeklyPayoutPeriodSSOT.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  WEEKLY_CREDIT_BUCKET,
  WEEKLY_PAYOUT_FEE_PENCE,
  WEEKLY_PAYOUT_PERIOD_TIMEZONE,
  classifyWeeklyPeriodCredit,
  freezeWeeklyOccurrencePeriod,
  resolvePreviousCompletedCalendarWeek,
  resolveWeeklyOccurrenceMoneyAmounts,
  selectWeeklyPeriodPayableCredits,
} from "../../functions/_shared/weeklyPayoutPeriodSSOT.ts";
import { planPayoutItemFromEligibleEntries } from "../../functions/_shared/payoutLedgerHandoffSSOT.ts";
import { evaluateDriverBatchEligibility } from "../../functions/_shared/weeklyDriverPayoutBatchWorkflowSSOT.ts";

const ROOT = new URL("../../", import.meta.url);
const KEY = "weekly-payout:milton-keynes:2026-09-22T12:00:00+01:00";
const PERIOD_START = "2026-09-13T23:00:00.000Z"; // 2026-09-14 00:00 Europe/London
const PERIOD_END = "2026-09-20T23:00:00.000Z"; // 2026-09-21 00:00 Europe/London

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, ROOT));
}

const PREVIOUS_WEEK = [
  {
    ledger_entry_id: "pw-1",
    trip_id: "t-1",
    amount_pence: 5000,
    type: "TRIP_EARNING_NET",
    economic_earned_at: "2026-09-14T10:00:00.000Z",
  },
  {
    ledger_entry_id: "pw-2",
    trip_id: "t-2",
    amount_pence: 3166,
    type: "TRIP_EARNING_NET",
    economic_earned_at: "2026-09-20T22:00:00.000Z",
  },
];
const CURRENT_WEEK = [
  {
    ledger_entry_id: "cw-425",
    trip_id: "t-mon",
    amount_pence: 425,
    type: "TRIP_EARNING_NET",
    economic_earned_at: "2026-09-21T09:00:00.000Z",
  },
  {
    ledger_entry_id: "cw-rest",
    trip_id: "t-mon-2",
    amount_pence: 3213,
    type: "TRIP_EARNING_NET",
    economic_earned_at: "2026-09-21T15:00:00.000Z",
  },
];
const HISTORICAL_PAID = [
  {
    ledger_entry_id: "old-paid",
    trip_id: "t-old",
    amount_pence: 4498,
    unpaid_pence: 0,
    type: "TRIP_EARNING_NET",
    economic_earned_at: "2026-09-10T12:00:00.000Z",
  },
];

Deno.test("period for Tuesday 22 Sep 2026 is previous London week 14–21 exclusive", () => {
  const period = resolvePreviousCompletedCalendarWeek({
    schedule_occurrence_key: KEY,
    scheduled_local_at: "2026-09-22T12:00:00+01:00",
    timezone: WEEKLY_PAYOUT_PERIOD_TIMEZONE,
    now: new Date("2026-09-22T14:30:00+01:00"),
  });
  assertEquals(period.period_start, PERIOD_START);
  assertEquals(period.period_end, PERIOD_END);
  assertEquals(period.timezone, WEEKLY_PAYOUT_PERIOD_TIMEZONE);
});

Deno.test("1. first on-time claim selects previous week only", () => {
  const scoped = selectWeeklyPeriodPayableCredits({
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    entries: [...PREVIOUS_WEEK, ...CURRENT_WEEK, ...HISTORICAL_PAID],
  });
  const lineage = planPayoutItemFromEligibleEntries({
    eligible_entries: scoped.selected,
    available_balance_pence: scoped.amount_pence,
  });
  assertEquals(scoped.amount_pence, 8166);
  assertEquals(lineage?.amount_pence, 8166);
  assertEquals(scoped.selected.map((e) => e.ledger_entry_id), ["pw-1", "pw-2"]);
  assertEquals(scoped.excluded_current_week_pence, 3638);
  assertEquals(scoped.excluded_older_unpaid_pence, 0);
});

Deno.test("2. delayed Tuesday execution selects the same rows and amount", () => {
  const onTime = resolvePreviousCompletedCalendarWeek({
    schedule_occurrence_key: KEY,
    now: new Date("2026-09-22T12:00:00+01:00"),
  });
  const delayed = resolvePreviousCompletedCalendarWeek({
    schedule_occurrence_key: KEY,
    now: new Date("2026-09-22T16:00:00+01:00"),
  });
  assertEquals(onTime, delayed);
  const scoped = selectWeeklyPeriodPayableCredits({
    period_start: delayed.period_start,
    period_end: delayed.period_end,
    entries: [...PREVIOUS_WEEK, ...CURRENT_WEEK],
  });
  assertEquals(scoped.amount_pence, 8166);
});

Deno.test("3. Monday earnings clearing after Tuesday 12:00 remain excluded", () => {
  const bucket = classifyWeeklyPeriodCredit({
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    entry: CURRENT_WEEK[0],
  });
  assertEquals(bucket, WEEKLY_CREDIT_BUCKET.CURRENT_WEEK_EXCLUDED);
  const scoped = selectWeeklyPeriodPayableCredits({
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    entries: [...PREVIOUS_WEEK, CURRENT_WEEK[0]],
  });
  assertEquals(scoped.amount_pence, 8166);
  assertEquals(scoped.excluded_current_week_pence, 425);
});

Deno.test("4. delayed retry after more credits clear remains unchanged", () => {
  const first = selectWeeklyPeriodPayableCredits({
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    entries: [...PREVIOUS_WEEK, CURRENT_WEEK[0]],
  });
  const later = selectWeeklyPeriodPayableCredits({
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    entries: [...PREVIOUS_WEEK, ...CURRENT_WEEK],
  });
  assertEquals(first.amount_pence, later.amount_pence);
  assertEquals(later.excluded_current_week_pence, 3638);
  const frozen = resolveWeeklyOccurrenceMoneyAmounts({
    frozen_items: [{ driver_id: "mk0006", amount_pence: first.amount_pence }],
    planned_items: [{ driver_id: "mk0006", amount_pence: later.amount_pence + 999 }],
  });
  assertEquals(frozen.source, "FROZEN_OCCURRENCE_MANIFEST");
  assertEquals(frozen.required_batch_pence, 8166);
});

Deno.test("5+6. dry-run and live coexist; concurrent claims share identity (migration)", async () => {
  const sql = await read("migrations/20261124160000_weekly_payout_occurrence_period_scope.sql");
  assertStringIncludes(sql, "ON CONFLICT (schedule_occurrence_key, dry_run) DO NOTHING");
  assertStringIncludes(sql, "AND dry_run = v_dry");
  assertStringIncludes(sql, "period_start");
  assertStringIncludes(sql, "period_end");
});

Deno.test("7. repeated execution reuses the frozen manifest", () => {
  const frozen = freezeWeeklyOccurrencePeriod({
    frozen_period_start: PERIOD_START,
    frozen_period_end: PERIOD_END,
    schedule_occurrence_key: KEY,
    now: new Date("2026-09-29T12:00:00+01:00"),
  });
  assertEquals(frozen.period_start, PERIOD_START);
  assertEquals(frozen.period_end, PERIOD_END);
  const money = resolveWeeklyOccurrenceMoneyAmounts({
    frozen_items: [{ driver_id: "mk0006", amount_pence: 8166 }],
    planned_items: [{ driver_id: "mk0006", amount_pence: 12000 }],
  });
  assertEquals(money.required_batch_pence, 8166);
});

Deno.test("8. historical completed early cash-outs are excluded", () => {
  const bucket = classifyWeeklyPeriodCredit({
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    entry: HISTORICAL_PAID[0],
  });
  assertEquals(bucket, WEEKLY_CREDIT_BUCKET.ALREADY_PAID);
  const olderUnpaid = classifyWeeklyPeriodCredit({
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    entry: {
      ledger_entry_id: "old-unpaid",
      amount_pence: 100,
      unpaid_pence: 100,
      type: "TRIP_EARNING_NET",
      economic_earned_at: "2026-09-10T12:00:00.000Z",
    },
  });
  assertEquals(olderUnpaid, WEEKLY_CREDIT_BUCKET.OLDER_UNPAID);
  const scoped = selectWeeklyPeriodPayableCredits({
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    entries: [...PREVIOUS_WEEK, ...HISTORICAL_PAID],
  });
  assertEquals(scoped.amount_pence, 8166);
});

Deno.test("9. MK0007 operational pause remains effective", () => {
  const decision = evaluateDriverBatchEligibility({
    driver_id: "56136f5f-1a3a-4a14-bb23-439b3951415a",
    wallet_balance_pence: 1526,
    available_payout_pence: 1526,
    payout_operational_paused: true,
    payouts_enabled: true,
    driver_held_or_blocked: false,
    currency: "GBP",
    expected_currency: "GBP",
    destination: {
      id: "dest",
      is_active: true,
      archived_at: null,
      provider_link_status: "PROVIDER_VERIFIED",
      provider_counterparty_id: "cp",
      provider_recipient_account_id: "acct",
    },
    has_conflicting_active_item: false,
  });
  assertEquals(decision.eligible, false);
  assertEquals(WEEKLY_PAYOUT_FEE_PENCE, 0);
});

Deno.test("10. no provider call occurs before the manifest is frozen", async () => {
  const src = await read("functions/admin-execute-weekly-payout-occurrence/index.ts");
  const persistAt = src.indexOf("await persistPayoutItemLedgerAllocations");
  const reserveAt = src.indexOf('"reserve_driver_payout_item"');
  const payAt = src.indexOf("await relayApprovedDriverPayoutPayment({");
  assertEquals(persistAt > 0, true);
  assertEquals(reserveAt > persistAt, true);
  assertEquals(payAt > reserveAt, true);
  assertEquals(src.indexOf("freezeWeeklyOccurrencePeriod") < persistAt, true);
  assertEquals(src.includes("available_balance_pence: eligibility.available_balance_pence"), false);
  assertStringIncludes(src, "selectWeeklyPeriodPayableCredits");
  assertStringIncludes(src, "available_balance_pence: scoped.amount_pence");
  assertEquals(src.includes("early_cashout_fee_pence"), false);
});

Deno.test("TEN without economic_earned_at is unattributed / fail-closed", () => {
  const bucket = classifyWeeklyPeriodCredit({
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    entry: {
      ledger_entry_id: "ten-null",
      amount_pence: 100,
      type: "TRIP_EARNING_NET",
      economic_earned_at: null,
      posting_created_at: "2026-09-16T12:00:00.000Z",
    },
  });
  assertEquals(bucket, WEEKLY_CREDIT_BUCKET.UNATTRIBUTED);
});

Deno.test("migration stamps London period and forbids payout/wallet/provider writes", async () => {
  const sql = await read("migrations/20261124160000_weekly_payout_occurrence_period_scope.sql");
  assertStringIncludes(sql, "weekly_payout_previous_completed_week");
  assertStringIncludes(sql, "Europe/London");
  assertStringIncludes(sql, "period_start is immutable");
  const body = sql.replace(/--[^\n]*/g, "");
  for (const forbidden of [
    "INSERT INTO public.payout_",
    "UPDATE public.payout_",
    "INSERT INTO public.driver_payout_",
    "UPDATE public.driver_wallet_ledger",
    "reserve_driver_payout_item",
    "finalize_driver_payout_completion",
  ]) {
    assertEquals(body.includes(forbidden), false, forbidden);
  }
});
