/**
 * Lock: cleared eligible TENs must not be permanently dropped from weekly selection.
 * MK-261015 / MK-261017 miss: residual-release stamped sessions that fail economic
 * attribution become UNATTRIBUTED; once attributed they carry forward as arrears.
 *
 * deno test --allow-read supabase/tests/_shared/weeklyPayoutMissedEarningsCarryforward.lock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  WEEKLY_CREDIT_BUCKET,
  classifyWeeklyPeriodCredit,
  selectWeeklyPeriodPayableCredits,
} from "../../functions/_shared/weeklyPayoutPeriodSSOT.ts";
import { planPayoutItemFromEligibleEntries } from "../../functions/_shared/payoutLedgerHandoffSSOT.ts";
import { aggregateDriverPayoutEligibility } from "../../functions/_shared/driverPayoutEligibilitySSOT.ts";

const PERIOD_START = "2026-10-11T23:00:00.000Z";
const PERIOD_END = "2026-10-18T23:00:00.000Z";
/** Next Monday occurrence — previous completed week is 19–26 London. */
const NEXT_PERIOD_START = "2026-10-18T23:00:00.000Z";
const NEXT_PERIOD_END = "2026-10-25T23:00:00.000Z";

Deno.test("CAPTURE_RELEASED TEN (null economic_earned_at) is UNATTRIBUTED and excluded", () => {
  const bucket = classifyWeeklyPeriodCredit({
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    entry: {
      ledger_entry_id: "015",
      amount_pence: 439,
      type: "TRIP_EARNING_NET",
      economic_earned_at: null,
      posting_created_at: "2026-10-15T09:50:53.610Z",
    },
  });
  assertEquals(bucket, WEEKLY_CREDIT_BUCKET.UNATTRIBUTED);
});

Deno.test("attributed TENs in-period are selected; null-econ TEN is reported unattributed", () => {
  const scoped = selectWeeklyPeriodPayableCredits({
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    entries: [
      {
        ledger_entry_id: "014n",
        amount_pence: 425,
        type: "TRIP_EARNING_NET",
        economic_earned_at: "2026-10-14T17:48:31.232Z",
      },
      {
        ledger_entry_id: "014t",
        amount_pence: 100,
        type: "DRIVER_TIP_CREDIT",
        economic_earned_at: "2026-10-14T17:48:32.727Z",
        posting_created_at: "2026-10-14T17:48:32.727Z",
      },
      {
        ledger_entry_id: "015",
        amount_pence: 439,
        type: "TRIP_EARNING_NET",
        economic_earned_at: null, // residual-release CAPTURE_RELEASED at plan time
        posting_created_at: "2026-10-15T09:50:53.610Z",
      },
      {
        ledger_entry_id: "017",
        amount_pence: 435,
        type: "TRIP_EARNING_NET",
        economic_earned_at: null,
        posting_created_at: "2026-10-17T08:33:00.813Z",
      },
    ],
  });
  assertEquals(scoped.previous_week_pence, 525);
  assertEquals(scoped.unattributed_pence, 874);
  assertEquals(scoped.unattributed_selected.map((e) => e.ledger_entry_id).sort(), ["015", "017"]);
  assertEquals(scoped.selected.map((e) => e.ledger_entry_id).sort(), ["014n", "014t"]);
});

Deno.test("next week carries attributed unpaid 015/017 as arrears (no duplicate of paid 014)", () => {
  const scoped = selectWeeklyPeriodPayableCredits({
    period_start: NEXT_PERIOD_START,
    period_end: NEXT_PERIOD_END,
    entries: [
      {
        ledger_entry_id: "014n",
        amount_pence: 425,
        unpaid_pence: 0, // already allocated / paid
        type: "TRIP_EARNING_NET",
        economic_earned_at: "2026-10-14T17:48:31.232Z",
      },
      {
        ledger_entry_id: "015",
        amount_pence: 439,
        type: "TRIP_EARNING_NET",
        economic_earned_at: "2026-10-15T09:50:51.813Z",
      },
      {
        ledger_entry_id: "017",
        amount_pence: 435,
        type: "TRIP_EARNING_NET",
        economic_earned_at: "2026-10-17T08:32:58.496Z",
      },
    ],
  });
  assertEquals(scoped.previous_week_pence, 0);
  assertEquals(scoped.arrears_pence, 874);
  assertEquals(scoped.amount_pence, 874);
  assertEquals(scoped.selected.map((e) => e.ledger_entry_id).sort(), ["015", "017"]);

  const lineage = planPayoutItemFromEligibleEntries({
    eligible_entries: scoped.selected.map((e) => ({
      ledger_entry_id: e.ledger_entry_id,
      amount_pence: e.amount_pence,
    })),
    available_balance_pence: scoped.amount_pence,
  });
  assertEquals(lineage?.amount_pence, 874);
  assertEquals(lineage?.allocations.length, 2);
});

Deno.test("plan-time eligibility with cleared 015/017 yields them in eligible_entries", () => {
  const now = Date.parse("2026-10-20T11:00:02.000Z");
  const policy = { clearing_delay_hours: 27, now_ms: now };
  const base = {
    trip_exists: true,
    trip_status: "completed",
    trip_cancelled: false,
    session_status: "captured",
    payment_session_id: "ps",
    refunded_amount_pence: 0,
    chargeback_hold: false,
    allocated_to_payout: false,
    allocated_amount_pence: 0,
    financial_model: "PLATFORM_COLLECTED",
    payment_collection_model: "PLATFORM_PREPAID",
    payment_method: "CARD",
    provider_state: "COMPLETED",
    fr_trip_status: "BALANCED",
  } as const;
  const agg = aggregateDriverPayoutEligibility({
    live_balance_pence: 1829,
    outstanding_debt_pence: 0,
    clearing_policy: policy,
    entries: [
      {
        ...base,
        ledger_entry_id: "014",
        trip_id: "t014",
        ledger_type: "TRIP_EARNING_NET",
        amount_pence: 425,
        captured_amount_pence: 600,
        canonical_driver_net_pence: 425,
        completed_at: "2026-10-14T17:48:20.848Z",
        captured_at: "2026-10-14T17:48:31.232Z",
        earning_credited_at: "2026-10-14T17:48:32.484Z",
      },
      {
        ...base,
        ledger_entry_id: "015",
        trip_id: "t015",
        ledger_type: "TRIP_EARNING_NET",
        amount_pence: 439,
        captured_amount_pence: 517,
        canonical_driver_net_pence: 439,
        completed_at: "2026-10-15T09:50:47.877Z",
        captured_at: "2026-10-15T09:50:51.813Z",
        earning_credited_at: "2026-10-15T09:50:53.610Z",
      },
      {
        ...base,
        ledger_entry_id: "017",
        trip_id: "t017",
        ledger_type: "TRIP_EARNING_NET",
        amount_pence: 435,
        captured_amount_pence: 500,
        canonical_driver_net_pence: 435,
        completed_at: "2026-10-17T08:32:10.749Z",
        captured_at: "2026-10-17T08:32:58.496Z",
        earning_credited_at: "2026-10-17T08:33:00.813Z",
      },
    ],
  });
  assertEquals(agg.eligible_entries.map((e) => e.ledger_entry_id).sort(), ["014", "015", "017"]);
  assertEquals(agg.eligible_entries.every((e) => e.ledger_type === "TRIP_EARNING_NET"), true);
});
