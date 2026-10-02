/**
 * Lock: Trip History and Missed & Cancelled are mutually exclusive for canonical
 * terminal outcomes. Ownership is decided in the queries — before count, range,
 * stats and ORDER BY — from financial_outcome, never status = cancelled and never
 * arrival_cancellation_applied.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MISSED_CANCELLED_STATUSES,
  TRIP_HISTORY_OWNED_FINANCIAL_OUTCOMES,
  belongsInMissedCancelled,
} from '../adminTripNoShowClassification';
import {
  MISSED_CANCELLED_CANCELLED_STATUSES,
  MISSED_CANCELLED_MISSED_STATUSES,
  MISSED_CANCELLED_OWNERSHIP_OR_FILTERS,
  missedCancelledStatusList,
} from '../adminTerminalPageOwnership';
import {
  missedCancelledEventAt,
  tripHistoryEventAt,
  type AdminTripDateSort,
} from '../adminTripListDateSort';
import {
  TRIP_HISTORY_FINANCIAL_OUTCOMES,
  tripHistoryDateOrFilter,
  tripHistoryTerminalOrFilter,
} from '../tripHistoryQuery';
import {
  matchesOr,
  missedCancelledOffsetPages,
  tripHistoryKeysetPages,
  type SimRow,
} from '../../test/tripListPostgrestSim';

const WINDOW_START = new Date('2026-09-25T00:00:00.000Z');
const WINDOW_END = new Date('2026-10-02T23:59:59.999Z');
const SORTS: AdminTripDateSort[] = ['newest', 'oldest'];

type ClassRow = Parameters<typeof belongsInMissedCancelled>[0];

const row = (r: Partial<SimRow> & { id: string }): SimRow => ({
  status: null,
  financial_outcome: null,
  completed_at: null,
  cancelled_at: null,
  created_at: null,
  no_show_charge_pence: null,
  cancellation_reason: null,
  arrival_cancellation_applied: null,
  ...r,
});

const MK_261002_014 = row({
  id: '118fe5ef-4e2e-4d48-814f-31b65839225b',
  status: 'cancelled',
  financial_outcome: 'ARRIVAL_CANCELLATION',
  arrival_cancellation_applied: false,
  cancellation_reason: 'booked-by-mistake',
  cancelled_at: '2026-10-02T12:29:40.350Z',
  created_at: '2026-10-02T12:26:09.979Z',
});
const MK_261002_015 = row({
  id: '98cab445-aa22-401a-8aac-e53210990273',
  status: 'no_show',
  financial_outcome: 'NO_SHOW',
  no_show_charge_pence: 450,
  cancellation_reason: 'no_show',
  cancelled_at: '2026-10-02T12:43:36.989Z',
  created_at: '2026-10-02T12:37:23.279Z',
});
const LATE = row({
  id: 'a0000000-0000-4000-8000-00000000000a',
  status: 'cancelled',
  financial_outcome: 'LATE_PASSENGER_CANCELLATION',
  cancelled_at: '2026-09-30T09:00:00.000Z',
  created_at: '2026-09-30T08:50:00.000Z',
});
const COMPLETED = row({
  id: 'b0000000-0000-4000-8000-00000000000b',
  status: 'completed',
  financial_outcome: 'COMPLETED',
  completed_at: '2026-10-01T18:00:00.500Z',
  created_at: '2026-10-01T17:20:00.000Z',
});
const CANCELLED_NO_FEE = row({
  id: 'c0000000-0000-4000-8000-00000000000c',
  status: 'cancelled',
  financial_outcome: 'CANCELLED_NO_FEE',
  cancelled_at: '2026-10-02T10:12:16.000Z',
  created_at: '2026-10-02T10:00:00.000Z',
});
const CANCELLED_NULL_OUTCOME = row({
  id: 'c1000000-0000-4000-8000-0000000000c1',
  status: 'cancelled',
  created_at: '2026-09-28T07:00:00.000Z',
});
const CUSTOMER_CANCELLED = row({
  id: 'c2000000-0000-4000-8000-0000000000c2',
  status: 'customer_cancelled',
  cancelled_at: '2026-09-27T15:00:00.000Z',
  created_at: '2026-09-27T14:55:00.000Z',
});
/** Pre-canonical arrival flag without a canonical outcome — stays operational. */
const LEGACY_ARRIVAL_FLAG = row({
  id: 'c3000000-0000-4000-8000-0000000000c3',
  status: 'cancelled',
  financial_outcome: 'CANCELLED_WITH_FEE',
  arrival_cancellation_applied: true,
  cancelled_at: '2026-09-26T11:00:00.000Z',
  created_at: '2026-09-26T10:40:00.000Z',
});
const MISSED = row({
  id: 'd0000000-0000-4000-8000-00000000000d',
  status: 'missed',
  cancelled_at: '2026-09-29T06:00:00.000Z',
  created_at: '2026-09-29T05:30:00.000Z',
});
const EXPIRED = row({
  id: 'd1000000-0000-4000-8000-0000000000d1',
  status: 'expired',
  created_at: '2026-09-29T06:00:00.000Z',
});
const EXPIRED_NO_DRIVER = row({
  id: 'd2000000-0000-4000-8000-0000000000d2',
  status: 'expired_no_driver',
  created_at: '2026-10-02T12:29:40.350Z',
});
/** August legacy shape: status cancelled + canonical NO_SHOW. */
const CANCELLED_STATUS_NO_SHOW = row({
  id: 'e0000000-0000-4000-8000-00000000000e',
  status: 'cancelled',
  financial_outcome: 'NO_SHOW',
  no_show_charge_pence: 400,
  cancelled_at: '2026-09-25T13:16:42.000Z',
  created_at: '2026-09-25T13:10:00.000Z',
});
const LEGACY_NO_SHOW_CHARGE = row({
  id: 'e1000000-0000-4000-8000-0000000000e1',
  status: 'cancelled',
  no_show_charge_pence: 300,
  cancelled_at: '2026-09-26T09:00:00.000Z',
  created_at: '2026-09-26T08:30:00.000Z',
});
const LEGACY_NO_SHOW_REASON = row({
  id: 'e2000000-0000-4000-8000-0000000000e2',
  status: 'cancelled',
  cancellation_reason: 'no_show',
  cancelled_at: '2026-09-26T09:30:00.000Z',
  created_at: '2026-09-26T09:00:00.000Z',
});

const TRIP_HISTORY_ONLY = [
  MK_261002_014, MK_261002_015, LATE, COMPLETED,
  CANCELLED_STATUS_NO_SHOW, LEGACY_NO_SHOW_CHARGE, LEGACY_NO_SHOW_REASON,
];
const MISSED_CANCELLED_ONLY = [
  CANCELLED_NO_FEE, CANCELLED_NULL_OUTCOME, CUSTOMER_CANCELLED, LEGACY_ARRIVAL_FLAG,
  MISSED, EXPIRED, EXPIRED_NO_DRIVER,
];
const FIXTURES = [...TRIP_HISTORY_ONLY, ...MISSED_CANCELLED_ONLY];

/** Trip History query: terminal OR + date window OR, then keyset pages. */
const tripHistoryBase = (rows: SimRow[]) => rows.filter((r) =>
  matchesOr(r, tripHistoryTerminalOrFilter('all'))
  && matchesOr(r, tripHistoryDateOrFilter(WINDOW_START, WINDOW_END)));

/** Missed & Cancelled query: created_at window + status + ownership groups (count and range share it). */
const missedCancelledBase = (rows: SimRow[], statuses: readonly string[] = MISSED_CANCELLED_STATUSES) =>
  rows.filter((r) => {
    const created = String(r.created_at ?? '');
    return created >= WINDOW_START.toISOString()
      && created <= WINDOW_END.toISOString()
      && statuses.includes(String(r.status))
      && MISSED_CANCELLED_OWNERSHIP_OR_FILTERS.every((f) => matchesOr(r, f));
  });

const tripHistoryIds = (rows: SimRow[], sort: AdminTripDateSort = 'newest', size = 100) =>
  tripHistoryKeysetPages(tripHistoryBase(rows), size, sort).flat();
const missedCancelledIds = (rows: SimRow[], sort: AdminTripDateSort = 'newest', size = 100, statuses?: readonly string[]) =>
  missedCancelledOffsetPages(missedCancelledBase(rows, statuses), size, sort).flat();

describe('Admin terminal page ownership — mutual exclusion', () => {
  it('union of both pages covers every fixture and the intersection is empty', () => {
    for (const sort of SORTS) {
      for (const size of [1, 2, 3, 50, 100]) {
        const th = tripHistoryIds(FIXTURES, sort, size);
        const mc = missedCancelledIds(FIXTURES, sort, size);
        expect(new Set(th).size).toBe(th.length);
        expect(new Set(mc).size).toBe(mc.length);
        expect(th.filter((id) => mc.includes(id))).toEqual([]);
        expect(new Set([...th, ...mc])).toEqual(new Set(FIXTURES.map((r) => r.id)));
      }
    }
  });

  it('MK-261002-014 and MK-261002-015: Trip History FOUND, Missed & Cancelled NOT FOUND', () => {
    const th = tripHistoryIds(FIXTURES);
    const mc = missedCancelledIds(FIXTURES);
    for (const r of [MK_261002_014, MK_261002_015]) {
      expect(th).toContain(r.id);
      expect(mc).not.toContain(r.id);
    }
  });

  it('each fixture has exactly its intended owner', () => {
    const th = new Set(tripHistoryIds(FIXTURES));
    const mc = new Set(missedCancelledIds(FIXTURES));
    for (const r of TRIP_HISTORY_ONLY) {
      expect({ id: r.id, th: th.has(r.id), mc: mc.has(r.id) }).toEqual({ id: r.id, th: true, mc: false });
    }
    for (const r of MISSED_CANCELLED_ONLY) {
      expect({ id: r.id, th: th.has(r.id), mc: mc.has(r.id) }).toEqual({ id: r.id, th: false, mc: true });
    }
  });

  it('canonical ARRIVAL / NO_SHOW / LATE / COMPLETED never pass Missed & Cancelled, whatever the status', () => {
    for (const outcome of TRIP_HISTORY_FINANCIAL_OUTCOMES) {
      for (const status of MISSED_CANCELLED_STATUSES) {
        for (const applied of [true, false, null]) {
          const r = row({
            id: `${outcome}-${status}-${applied}`,
            status,
            financial_outcome: outcome,
            arrival_cancellation_applied: applied,
            completed_at: outcome === 'COMPLETED' ? '2026-10-01T10:00:00.000Z' : null,
            cancelled_at: '2026-10-01T10:00:00.000Z',
            created_at: '2026-10-01T09:00:00.000Z',
          });
          expect(MISSED_CANCELLED_OWNERSHIP_OR_FILTERS.every((f) => matchesOr(r, f))).toBe(false);
          expect(belongsInMissedCancelled(r as ClassRow)).toBe(false);
          expect(missedCancelledIds([r])).toEqual([]);
          expect(tripHistoryIds([r])).toEqual([r.id]);
        }
      }
    }
  });

  it('ordinary cancellations with NULL financial_outcome are kept (NULL-safe exclusion)', () => {
    expect(missedCancelledIds([CANCELLED_NULL_OUTCOME, EXPIRED])).toHaveLength(2);
    // A bare not.in would drop them: NULL NOT IN (...) is unknown.
    expect(matchesOr(
      CANCELLED_NULL_OUTCOME,
      `financial_outcome.not.in.(${TRIP_HISTORY_FINANCIAL_OUTCOMES.join(',')})`,
    )).toBe(false);
  });

  it('shared SSOT agrees with the server filter for every fixture', () => {
    for (const r of FIXTURES) {
      const server = (MISSED_CANCELLED_STATUSES as readonly string[]).includes(String(r.status))
        && MISSED_CANCELLED_OWNERSHIP_OR_FILTERS.every((f) => matchesOr(r, f));
      expect({ id: r.id, ssot: belongsInMissedCancelled(r as ClassRow) }).toEqual({ id: r.id, ssot: server });
    }
  });

  it('owned outcome lists stay identical across the Deno SSOT and the Admin query', () => {
    expect([...TRIP_HISTORY_OWNED_FINANCIAL_OUTCOMES]).toEqual([...TRIP_HISTORY_FINANCIAL_OUTCOMES]);
  });
});

describe('Missed & Cancelled count, stats and filters exclude Trip History outcomes', () => {
  it('list total equals Cancelled + Missed stats, all owned rows only', () => {
    const total = missedCancelledBase(FIXTURES).length;
    const cancelled = missedCancelledBase(FIXTURES, MISSED_CANCELLED_CANCELLED_STATUSES).length;
    const missed = missedCancelledBase(FIXTURES, MISSED_CANCELLED_MISSED_STATUSES).length;
    expect(total).toBe(MISSED_CANCELLED_ONLY.length);
    expect(cancelled).toBe(4);
    expect(missed).toBe(3);
    expect(cancelled + missed).toBe(total);
    expect(missedCancelledIds(FIXTURES, 'newest', 2)).toHaveLength(total);
  });

  it('status filters stay inside ownership', () => {
    const ids = (filter: string) => missedCancelledIds(FIXTURES, 'newest', 100, missedCancelledStatusList(filter)).sort();
    expect(ids('cancelled')).toEqual([CANCELLED_NO_FEE.id, CANCELLED_NULL_OUTCOME.id, LEGACY_ARRIVAL_FLAG.id].sort());
    expect(ids('customer_cancelled')).toEqual([CUSTOMER_CANCELLED.id]);
    expect(ids('missed')).toEqual([MISSED.id]);
    expect(ids('expired')).toEqual([EXPIRED.id, EXPIRED_NO_DRIVER.id].sort());
    expect(missedCancelledStatusList('no_show')).toEqual([...MISSED_CANCELLED_STATUSES]);
  });
});

describe('Each page sorts only the trips it owns', () => {
  const oracle = (rows: SimRow[], at: (r: SimRow) => string, sort: AdminTripDateSort) => {
    const dir = sort === 'oldest' ? 1 : -1;
    return [...rows]
      .sort((a, b) => (at(a) === at(b) ? (a.id < b.id ? -1 : 1) : at(a) < at(b) ? -1 : 1) * dir)
      .map((r) => r.id);
  };

  for (const sort of SORTS) {
    it(`${sort} first: Trip History and Missed & Cancelled orders cover disjoint owned sets`, () => {
      const thExpected = oracle(TRIP_HISTORY_ONLY, (r) => String(tripHistoryEventAt(r as never)), sort);
      const mcExpected = oracle(MISSED_CANCELLED_ONLY, (r) => String(missedCancelledEventAt(r as never)), sort);
      for (const size of [1, 4, 100]) {
        expect(tripHistoryIds(FIXTURES, sort, size)).toEqual(thExpected);
        expect(missedCancelledIds(FIXTURES, sort, size)).toEqual(mcExpected);
      }
    });
  }

  it('Newest first: 014 heads neither the Missed & Cancelled list nor any of its pages', () => {
    const pages = missedCancelledOffsetPages(missedCancelledBase(FIXTURES), 1, 'newest');
    expect(pages.flat()[0]).toBe(EXPIRED_NO_DRIVER.id);
    expect(pages.some((p) => p.includes(MK_261002_014.id))).toBe(false);
  });
});

describe('Missed & Cancelled page wiring lock', () => {
  const src = readFileSync(resolve(__dirname, '../../pages/MissedCancelled.tsx'), 'utf8');

  it('scopes the list query with the ownership filter before count, order and range', () => {
    const own = src.indexOf('query = applyMissedCancelledOwnership(query)');
    const order = src.indexOf('.order(MISSED_CANCELLED_EVENT_AT_COLUMN, { ascending })');
    const range = src.indexOf('.range(from, to)');
    expect(own).toBeGreaterThan(-1);
    expect(order).toBeGreaterThan(own);
    expect(range).toBeGreaterThan(own);
    expect(src).toContain("query = query.in('status', missedCancelledStatusList(statusFilter))");
  });

  it('scopes every stat query (Cancelled, Missed, fare rows) and drops the no_show status count', () => {
    expect((src.match(/applyMissedCancelledOwnership\(supabase/g) ?? []).length).toBe(3);
    expect(src).not.toContain('MISSED_CANCELLED_STATS_EXTRA_STATUSES');
    expect(src).not.toContain('noShowStatus');
    expect(src).toContain('const totalIssues = cancelledCount + missedCount;');
  });

  it('no longer reports chargeable terminal outcomes as Missed & Cancelled stats', () => {
    expect(src).not.toContain('Chargeable outcomes');
    expect(src).not.toContain('No-Show: {bucketStats.no_show}');
  });
});
