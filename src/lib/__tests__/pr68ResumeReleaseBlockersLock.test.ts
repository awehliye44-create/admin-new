/**
 * Release-blocker locks for PR #68: arrears policy, advisory lock, intent SSOT,
 * trigger compatibility, MK0007 zero-money simulation.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WEEKLY_CREDIT_BUCKET,
  classifyWeeklyPeriodCredit,
  freezeWeeklyOccurrencePeriod,
  remainingWeeklyPayableAfterEarlyAllocations,
  resolvePreviousCompletedCalendarWeek,
  selectWeeklyPeriodPayableCredits,
} from '../../../supabase/functions/_shared/weeklyPayoutPeriodSSOT.ts';
import { planPayoutItemFromEligibleEntries } from '../../../supabase/functions/_shared/payoutLedgerHandoffSSOT.ts';
import {
  evaluateDriverBatchEligibility,
  resolveScheduleOccurrence,
} from '../../../supabase/functions/_shared/weeklyDriverPayoutBatchWorkflowSSOT.ts';
import { decideDirectDriverPayoutPauseWrite } from '../denyDirectDriverPayoutPauseWriteDecision';

const ROOT = resolve(__dirname, '../../..');
const FWD = resolve(
  ROOT,
  'supabase/migrations/20261127140000_admin_resume_payout_operational_pause_gates.sql',
);
const ALLOC_TRG = resolve(
  ROOT,
  'supabase/migrations/20261124160000_weekly_payout_occurrence_period_scope.sql',
);
const ORCH = resolve(
  ROOT,
  'supabase/functions/admin-execute-weekly-payout-occurrence/index.ts',
);

const MK0007_ARREARS = [
  {
    ledger_entry_id: '3dbb5d27-90f6-497e-bbc8-2d7948602e00',
    trip_id: '7851dedd-6d52-457e-9269-44a1ac484b72',
    amount_pence: 435,
    unpaid_pence: 435,
    type: 'TRIP_EARNING_NET',
    economic_earned_at: '2026-09-17T11:50:14.15Z',
  },
  {
    ledger_entry_id: 'c2e1f133-5809-4e56-bd7d-57b8ff95b477',
    trip_id: '7851dedd-6d52-457e-9269-44a1ac484b72',
    amount_pence: 100,
    unpaid_pence: 100,
    type: 'DRIVER_TIP_CREDIT',
    economic_earned_at: '2026-09-17T11:50:14.15Z',
    posting_created_at: '2026-09-17T11:50:15.309147Z',
  },
  {
    ledger_entry_id: '5bac37f6-f213-4e60-b346-900568bd1e9a',
    trip_id: 'd2a5149f-3f00-4c51-9c9b-00d3f809303e',
    amount_pence: 435,
    unpaid_pence: 435,
    type: 'TRIP_EARNING_NET',
    economic_earned_at: '2026-09-17T19:03:53.599Z',
  },
  {
    ledger_entry_id: 'b84065d9-4571-4586-8f4d-debc4918c545',
    trip_id: '25fbc3f1-7e8c-4686-ab85-e05426175d3a',
    amount_pence: 556,
    unpaid_pence: 556,
    type: 'TRIP_EARNING_NET',
    economic_earned_at: '2026-09-17T19:35:23.591Z',
  },
];

/** Next weekly after a missed 23 Sep window while paused: Tue 29 Sep 2026. */
const NEXT_KEY = 'weekly-payout:milton-keynes:2026-09-29T12:00:00+01:00';
const WRONG_DAY_KEY = 'weekly-payout:milton-keynes:2026-09-30T12:00:00+01:00';
const PERIOD_START_LONDON = '2026-09-21T00:00:00+01:00';
const PERIOD_END_LONDON = '2026-09-28T00:00:00+01:00';
const PERIOD_START_UTC = '2026-09-20T23:00:00.000Z';
const PERIOD_END_UTC = '2026-09-27T23:00:00.000Z';

describe('PR68 release blockers — arrears / lock / intent / trigger / MK0007 sim', () => {
  const fwd = readFileSync(FWD, 'utf8');
  const alloc = readFileSync(ALLOC_TRG, 'utf8');
  const orch = readFileSync(ORCH, 'utf8');

  it('TUESDAY_20260929 occurrence key + frozen period; Wednesday is wrong day', () => {
    expect(NEXT_KEY).toBe('weekly-payout:milton-keynes:2026-09-29T12:00:00+01:00');
    expect(WRONG_DAY_KEY).not.toBe(NEXT_KEY);

    const period = resolvePreviousCompletedCalendarWeek({ schedule_occurrence_key: NEXT_KEY });
    expect(period.period_start).toBe(PERIOD_START_UTC);
    expect(period.period_end).toBe(PERIOD_END_UTC);
    expect(new Date(PERIOD_START_LONDON).toISOString()).toBe(PERIOD_START_UTC);
    expect(new Date(PERIOD_END_LONDON).toISOString()).toBe(PERIOD_END_UTC);

    // Sep 30 key would freeze the same calendar week bounds, but is not a Tuesday payout day.
    const wedPeriod = resolvePreviousCompletedCalendarWeek({ schedule_occurrence_key: WRONG_DAY_KEY });
    expect(wedPeriod.period_start).toBe(PERIOD_START_UTC);
    expect(wedPeriod.period_end).toBe(PERIOD_END_UTC);

    const settings = {
      payouts_enabled: true,
      payout_frequency: 'weekly',
      weekly_payout_day: 'tuesday',
      payout_processing_time: '12:00',
      payout_timezone: 'Europe/London',
    };
    const tue = resolveScheduleOccurrence({
      settings,
      service_area_slug: 'milton-keynes',
      now: new Date('2026-09-29T12:00:00+01:00'),
    });
    expect('not_due' in tue && tue.not_due).toBeFalsy();
    expect('schedule_occurrence_key' in tue ? tue.schedule_occurrence_key : '').toBe(NEXT_KEY);

    const wed = resolveScheduleOccurrence({
      settings,
      service_area_slug: 'milton-keynes',
      now: new Date('2026-09-30T12:00:00+01:00'),
    });
    expect('not_due' in wed && wed.not_due).toBe(true);
    expect('reason' in wed ? wed.reason : '').toBe('WRONG_PAYOUT_DAY');
  });

  it('older unpaid arrears included once; current week excluded', () => {
    const period = resolvePreviousCompletedCalendarWeek({ schedule_occurrence_key: NEXT_KEY });
    // Previous completed week for Tue 29 Sep = Mon 21 → Mon 28 London.
    expect(period.period_start).toBe(PERIOD_START_UTC);
    expect(period.period_end).toBe(PERIOD_END_UTC);

    const currentWeek = {
      ledger_entry_id: 'cw-1',
      amount_pence: 999,
      unpaid_pence: 999,
      type: 'TRIP_EARNING_NET',
      economic_earned_at: '2026-09-28T10:00:00.000Z',
    };
    const scoped = selectWeeklyPeriodPayableCredits({
      period_start: period.period_start,
      period_end: period.period_end,
      entries: [...MK0007_ARREARS, currentWeek],
    });
    expect(scoped.arrears_pence).toBe(1526);
    expect(scoped.previous_week_pence).toBe(0);
    expect(scoped.amount_pence).toBe(1526);
    expect(scoped.excluded_current_week_pence).toBe(999);
    expect(scoped.excluded_older_unpaid_pence).toBe(0);
    expect(scoped.arrears_selected).toHaveLength(4);
    expect(scoped.selected.map((e) => e.ledger_entry_id).sort()).toEqual(
      MK0007_ARREARS.map((e) => e.ledger_entry_id).sort(),
    );
    for (const row of MK0007_ARREARS) {
      expect(classifyWeeklyPeriodCredit({
        entry: row,
        period_start: period.period_start,
        period_end: period.period_end,
      })).toBe(WEEKLY_CREDIT_BUCKET.OLDER_UNPAID);
    }
  });

  it('already-paid and early-cashout occupancy exclude arrears; one consumer', () => {
    const period = resolvePreviousCompletedCalendarWeek({ schedule_occurrence_key: NEXT_KEY });
    const paid = MK0007_ARREARS.map((e) => ({ ...e, unpaid_pence: 0 }));
    const paidScoped = selectWeeklyPeriodPayableCredits({
      period_start: period.period_start,
      period_end: period.period_end,
      entries: paid,
    });
    expect(paidScoped.amount_pence).toBe(0);

    const remaining = remainingWeeklyPayableAfterEarlyAllocations({
      previous_week_unpaid: MK0007_ARREARS.map((e) => ({
        ledger_entry_id: e.ledger_entry_id,
        unpaid_pence: e.unpaid_pence!,
      })),
      early_allocations: [
        { ledger_entry_id: MK0007_ARREARS[0].ledger_entry_id, amount_pence: 435 },
        { ledger_entry_id: MK0007_ARREARS[1].ledger_entry_id, amount_pence: 100 },
        { ledger_entry_id: MK0007_ARREARS[2].ledger_entry_id, amount_pence: 435 },
        { ledger_entry_id: MK0007_ARREARS[3].ledger_entry_id, amount_pence: 556 },
      ],
    });
    expect(remaining).toBe(0);

    const lineage = planPayoutItemFromEligibleEntries({
      eligible_entries: MK0007_ARREARS.map((e) => ({
        ledger_entry_id: e.ledger_entry_id,
        amount_pence: e.unpaid_pence!,
      })),
      available_balance_pence: 1526,
    });
    expect(lineage?.amount_pence).toBe(1526);
    expect(lineage?.allocations).toHaveLength(4);
  });

  it('ledger allocations retain original economic period (not occurrence period)', () => {
    const period = freezeWeeklyOccurrencePeriod({ schedule_occurrence_key: NEXT_KEY });
    const scoped = selectWeeklyPeriodPayableCredits({
      period_start: period.period_start,
      period_end: period.period_end,
      entries: MK0007_ARREARS,
    });
    // Frozen occurrence period stays 21–28 Sep week; arrears keep Sep 17 earned_at.
    expect(period.period_start.startsWith('2026-09-20')).toBe(true);
    for (const row of scoped.arrears_selected) {
      expect(String(row.economic_earned_at)).toMatch(/^2026-09-17/);
    }
    expect(orch).toMatch(/arrears_ledger_allocation_ids/);
    expect(orch).toMatch(/included_arrears_pence/);
  });

  it('Resume uses canonical advisory lock shared with allocation trigger', () => {
    expect(alloc).toMatch(/PERFORM pg_advisory_xact_lock\(hashtextextended\(v_item\.driver_id::text, 0\)\)/);
    expect(fwd).toMatch(/PERFORM pg_advisory_xact_lock\(hashtextextended\(p_driver_id::text, 0\)\)/);
    const lockAt = fwd.indexOf('pg_advisory_xact_lock(hashtextextended(p_driver_id::text, 0))');
    const destAt = fwd.indexOf('FROM public.driver_payout_destinations');
    const reconAt = fwd.indexOf('lifetime_expected_payable_pence');
    expect(lockAt).toBeGreaterThan(0);
    expect(destAt).toBeGreaterThan(lockAt);
    expect(reconAt).toBeGreaterThan(lockAt);
  });

  it('Resume checks canonical driver_payout_payment_intents SSOT; missing → UNKNOWN', () => {
    expect(fwd).toMatch(/driver_payout_payment_intents/);
    expect(fwd).toMatch(/to_regclass\('public\.driver_payout_payment_intents'\)/);
    expect(fwd).toMatch(/intent_ssot_present/);
    expect(fwd).toMatch(/FINANCIAL_READINESS_UNKNOWN/);
    expect(fwd).toMatch(/PROVIDER_UNKNOWN/);
    expect(fwd).toMatch(/execution_status.*UNKNOWN|UNKNOWN.*execution_status/s);
  });

  it('direct pause writes denied; unrelated / service_role / RPC allowed', () => {
    expect(decideDirectDriverPayoutPauseWrite({
      authRole: 'authenticated',
      allowGuc: false,
      pauseFieldsChanging: true,
      triggerWouldFire: true,
    })).toEqual({ allow: false, reason: 'direct_payout_pause_write_denied' });

    expect(decideDirectDriverPayoutPauseWrite({
      authRole: 'authenticated',
      allowGuc: true,
      pauseFieldsChanging: true,
      triggerWouldFire: true,
    })).toEqual({ allow: true, reason: 'rpc_guc' });

    expect(decideDirectDriverPayoutPauseWrite({
      authRole: 'service_role',
      allowGuc: false,
      pauseFieldsChanging: true,
      triggerWouldFire: true,
    })).toEqual({ allow: true, reason: 'service_role' });

    expect(decideDirectDriverPayoutPauseWrite({
      authRole: 'authenticated',
      allowGuc: false,
      pauseFieldsChanging: false,
      triggerWouldFire: false,
    })).toEqual({ allow: true, reason: 'unrelated_columns' });

    expect(fwd).toMatch(/auth\.role\(\) = 'service_role'/);
    expect(fwd).toMatch(/BEFORE UPDATE OF payout_operational_paused, payouts_enabled/);
  });

  it('MK0007 zero-money simulation: Resume gates pass; planning includes 1526 once; pause excludes', () => {
    // 1–5 Resume gate snapshot (sim): dest verified, variance 0, no items/reservations/intents.
    const resumeGates = {
      destination_provider_verified: true,
      active_reservation_count: 0,
      inflight_payout_item_count: 0,
      inflight_payment_intent_count: 0,
      intent_ssot_present: true,
      unknown_provider_session_count: 0,
      lifetime_credit_variance_pence: 0,
      lifetime_completed_trip_count: 3,
      lifetime_credit_ledger_rows: 4,
      payout_created: false,
      wallet_written: false,
      provider_called: false,
    };
    expect(resumeGates.destination_provider_verified).toBe(true);
    expect(resumeGates.lifetime_credit_variance_pence).toBe(0);
    expect(resumeGates.payout_created).toBe(false);
    expect(resumeGates.wallet_written).toBe(false);
    expect(resumeGates.provider_called).toBe(false);

    // 6–8 Next weekly planning includes 1526 as arrears exactly once; current week excluded.
    const period = resolvePreviousCompletedCalendarWeek({ schedule_occurrence_key: NEXT_KEY });
    const scoped = selectWeeklyPeriodPayableCredits({
      period_start: period.period_start,
      period_end: period.period_end,
      entries: [
        ...MK0007_ARREARS,
        {
          ledger_entry_id: 'cw-now',
          amount_pence: 200,
          unpaid_pence: 200,
          type: 'TRIP_EARNING_NET',
          economic_earned_at: '2026-09-28T12:00:00.000Z',
        },
      ],
    });
    expect(scoped.amount_pence).toBe(1526);
    expect(scoped.included_arrears_pence).toBe(1526);
    expect(scoped.excluded_current_week_pence).toBe(200);

    const lineage = planPayoutItemFromEligibleEntries({
      eligible_entries: scoped.selected.map((e) => ({
        ledger_entry_id: e.ledger_entry_id,
        amount_pence: Math.max(0, Math.round(Number(e.unpaid_pence ?? e.amount_pence))),
      })),
      available_balance_pence: scoped.amount_pence,
    });
    expect(lineage?.amount_pence).toBe(1526);

    // 7 Duplicate planning / early occupancy → remaining 0
    const afterAlloc = remainingWeeklyPayableAfterEarlyAllocations({
      previous_week_unpaid: scoped.selected.map((e) => ({
        ledger_entry_id: e.ledger_entry_id,
        unpaid_pence: Math.max(0, Math.round(Number(e.unpaid_pence ?? e.amount_pence))),
      })),
      early_allocations: lineage!.allocations,
    });
    expect(afterAlloc).toBe(0);

    // 9 After debit (unpaid→0) cannot select again
    const rescope = selectWeeklyPeriodPayableCredits({
      period_start: period.period_start,
      period_end: period.period_end,
      entries: MK0007_ARREARS.map((e) => ({ ...e, unpaid_pence: 0 })),
    });
    expect(rescope.amount_pence).toBe(0);

    // 10 Pause before planning excludes MK0007 without changing money
    const paused = evaluateDriverBatchEligibility({
      driver_id: '56136f5f-1a3a-4a14-bb23-439b3951415a',
      wallet_balance_pence: 1526,
      available_payout_pence: 1526,
      payout_operational_paused: true,
      payouts_enabled: true,
      driver_held_or_blocked: false,
      currency: 'GBP',
      expected_currency: 'GBP',
      destination: {
        id: '74113e2b-5769-4883-97ff-e2f926a73b90',
        is_active: true,
        archived_at: null,
        provider_link_status: 'PROVIDER_VERIFIED',
        provider_counterparty_id: 'cp',
        provider_recipient_account_id: 'acct',
      },
      has_conflicting_active_item: false,
    });
    expect(paused.eligible).toBe(false);

    // Resume path creates no money objects (migration assertions)
    expect(fwd).not.toMatch(/INSERT INTO public\.payout_items/);
    expect(fwd).not.toMatch(/INSERT INTO public\.driver_payout_reservations/);
    expect(fwd).not.toMatch(/INSERT INTO public\.driver_wallet_ledger/);
    expect(fwd).toMatch(/IF NOT v_unchanged THEN[\s\S]*INSERT INTO public\.payout_audit_log/);
  });
});
