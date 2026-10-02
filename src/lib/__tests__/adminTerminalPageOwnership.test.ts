/**
 * Lock: Trip History and Missed & Cancelled are mutually exclusive for canonical
 * terminal outcomes. Ownership is decided in the queries (before pagination, counts,
 * stats and sorting) from financial_outcome — never status = cancelled and never
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
  MISSED_CANCELLED_EVENT_BANDS,
  MISSED_CANCELLED_MISSED_STATUSES,
  MISSED_CANCELLED_OWNERSHIP_OR_FILTERS,
  missedCancelledEventAt,
  missedCancelledEventWindowOrFilter,
  missedCancelledStatusList,
} from '../adminTerminalPageOwnership';
import { eventTimestampMicros, type AdminEventBand, type AdminSortOrder } from '../adminEventOrder';
import {
  TRIP_HISTORY_EVENT_BANDS,
  TRIP_HISTORY_FINANCIAL_OUTCOMES,
  tripHistoryDateOrFilter,
  tripHistoryTerminalOrFilter,
} from '../tripHistoryQuery';
import { matchesAllOr, matchesOr, simulateAllPages, type SimRow } from './helpers/postgrestSim';

const WINDOW_START = new Date('2026-09-25T00:00:00.000Z');
const WINDOW_END = new Date('2026-10-02T23:59:59.999Z');

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

/** Production shapes (timestamps as PostgREST returns them). */
const MK_261002_014 = row({
  id: '118fe5ef-4e2e-4d48-814f-31b65839225b',
  status: 'cancelled',
  financial_outcome: 'ARRIVAL_CANCELLATION',
  arrival_cancellation_applied: false,
  cancellation_reason: 'booked-by-mistake',
  cancelled_at: '2026-10-02T12:29:40.350908+00:00',
  created_at: '2026-10-02T12:26:09.979614+00:00',
});
const MK_261002_015 = row({
  id: '98cab445-aa22-401a-8aac-e53210990273',
  status: 'no_show',
  financial_outcome: 'NO_SHOW',
  no_show_charge_pence: 450,
  cancellation_reason: 'no_show',
  cancelled_at: '2026-10-02T12:43:36.989+00:00',
  created_at: '2026-10-02T12:37:23.279+00:00',
});
const LATE = row({
  id: 'a0000000-0000-4000-8000-00000000000a',
  status: 'cancelled',
  financial_outcome: 'LATE_PASSENGER_CANCELLATION',
  cancelled_at: '2026-09-30T09:00:00+00:00',
  created_at: '2026-09-30T08:50:00+00:00',
});
const COMPLETED = row({
  id: 'b0000000-0000-4000-8000-00000000000b',
  status: 'completed',
  financial_outcome: 'COMPLETED',
  completed_at: '2026-10-01T18:00:00.5+00:00',
  created_at: '2026-10-01T17:20:00+00:00',
});
const CANCELLED_NO_FEE = row({
  id: 'c0000000-0000-4000-8000-00000000000c',
  status: 'cancelled',
  financial_outcome: 'CANCELLED_NO_FEE',
  cancelled_at: '2026-10-02T10:12:16+00:00',
  created_at: '2026-10-02T10:00:00+00:00',
});
const CANCELLED_NULL_OUTCOME = row({
  id: 'c1000000-0000-4000-8000-0000000000c1',
  status: 'cancelled',
  cancelled_at: null,
  created_at: '2026-09-28T07:00:00+00:00',
});
const CUSTOMER_CANCELLED = row({
  id: 'c2000000-0000-4000-8000-0000000000c2',
  status: 'customer_cancelled',
  cancelled_at: '2026-09-27T15:00:00+00:00',
  created_at: '2026-09-27T14:55:00+00:00',
});
/** Pre-canonical arrival flag without a canonical outcome — stays operational. */
const LEGACY_ARRIVAL_FLAG = row({
  id: 'c3000000-0000-4000-8000-0000000000c3',
  status: 'cancelled',
  financial_outcome: 'CANCELLED_WITH_FEE',
  arrival_cancellation_applied: true,
  cancelled_at: '2026-09-26T11:00:00+00:00',
  created_at: '2026-09-26T10:40:00+00:00',
});
const MISSED = row({
  id: 'd0000000-0000-4000-8000-00000000000d',
  status: 'missed',
  cancelled_at: '2026-09-29T06:00:00+00:00',
  created_at: '2026-09-29T05:30:00+00:00',
});
const EXPIRED = row({
  id: 'd1000000-0000-4000-8000-0000000000d1',
  status: 'expired',
  cancelled_at: null,
  created_at: '2026-09-29T06:00:00+00:00',
});
const EXPIRED_NO_DRIVER = row({
  id: 'd2000000-0000-4000-8000-0000000000d2',
  status: 'expired_no_driver',
  cancelled_at: null,
  created_at: '2026-10-02T12:29:40.350908+00:00',
});
/** August legacy shape: status cancelled + canonical NO_SHOW. */
const CANCELLED_STATUS_NO_SHOW = row({
  id: 'e0000000-0000-4000-8000-00000000000e',
  status: 'cancelled',
  financial_outcome: 'NO_SHOW',
  no_show_charge_pence: 400,
  cancelled_at: '2026-09-25T13:16:42+00:00',
  created_at: '2026-09-25T13:10:00+00:00',
});
const LEGACY_NO_SHOW_CHARGE = row({
  id: 'e1000000-0000-4000-8000-0000000000e1',
  status: 'cancelled',
  no_show_charge_pence: 300,
  cancelled_at: '2026-09-26T09:00:00+00:00',
  created_at: '2026-09-26T08:30:00+00:00',
});
const LEGACY_NO_SHOW_REASON = row({
  id: 'e2000000-0000-4000-8000-0000000000e2',
  status: 'cancelled',
  cancellation_reason: 'no_show',
  cancelled_at: '2026-09-26T09:30:00+00:00',
  created_at: '2026-09-26T09:00:00+00:00',
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

const tripHistoryScope = (r: SimRow) =>
  matchesOr(r, tripHistoryTerminalOrFilter('all'))
  && matchesOr(r, tripHistoryDateOrFilter(WINDOW_START, WINDOW_END));

const missedCancelledScope = (statusFilter = 'all') => (r: SimRow, band: AdminEventBand) =>
  missedCancelledStatusList(statusFilter).includes(String(r.status))
  && matchesAllOr(r, MISSED_CANCELLED_OWNERSHIP_OR_FILTERS)
  && matchesAllOr(r, [
    `${band.column}.gte.${WINDOW_START.toISOString()}`,
    `${band.column}.lte.${WINDOW_END.toISOString()}`,
  ]);

/** Head count exactly as the page builds it (no band split). */
const missedCancelledCount = (rows: SimRow[], statuses: readonly string[]) =>
  rows.filter((r) =>
    statuses.includes(String(r.status))
    && matchesAllOr(r, MISSED_CANCELLED_OWNERSHIP_OR_FILTERS)
    && matchesOr(r, missedCancelledEventWindowOrFilter(WINDOW_START, WINDOW_END))).length;

const tripHistoryIds = (rows: SimRow[], order: AdminSortOrder = 'newest', size = 100) =>
  simulateAllPages(rows, TRIP_HISTORY_EVENT_BANDS, tripHistoryScope, order, size);
const missedCancelledIds = (rows: SimRow[], order: AdminSortOrder = 'newest', size = 100, status = 'all') =>
  simulateAllPages(rows, MISSED_CANCELLED_EVENT_BANDS, missedCancelledScope(status), order, size);

describe('Admin terminal page ownership — mutual exclusion', () => {
  it('union of both pages covers every fixture and the intersection is empty', () => {
    for (const order of ['newest', 'oldest'] as const) {
      for (const size of [1, 2, 3, 50, 100]) {
        const th = tripHistoryIds(FIXTURES, order, size);
        const mc = missedCancelledIds(FIXTURES, order, size);
        expect(new Set(th).size).toBe(th.length);
        expect(new Set(mc).size).toBe(mc.length);
        const intersection = th.filter((id) => mc.includes(id));
        expect(intersection).toEqual([]);
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
    expect([MK_261002_014.id, MK_261002_015.id].filter((id) => mc.includes(id))).toEqual([]);
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
            completed_at: outcome === 'COMPLETED' ? '2026-10-01T10:00:00+00:00' : null,
            cancelled_at: '2026-10-01T10:00:00+00:00',
            created_at: '2026-10-01T09:00:00+00:00',
          });
          expect(matchesAllOr(r, MISSED_CANCELLED_OWNERSHIP_OR_FILTERS)).toBe(false);
          expect(belongsInMissedCancelled(r as ClassRow)).toBe(false);
          expect(missedCancelledIds([r])).toEqual([]);
          expect(missedCancelledCount([r], MISSED_CANCELLED_STATUSES)).toBe(0);
          expect(tripHistoryIds([r])).toEqual([r.id]);
        }
      }
    }
  });

  it('ordinary cancellations with NULL financial_outcome are kept (NULL-safe exclusion)', () => {
    expect(matchesAllOr(CANCELLED_NULL_OUTCOME, MISSED_CANCELLED_OWNERSHIP_OR_FILTERS)).toBe(true);
    expect(matchesAllOr(EXPIRED, MISSED_CANCELLED_OWNERSHIP_OR_FILTERS)).toBe(true);
    // A bare not.in would drop them: NULL NOT IN (...) is unknown.
    expect(matchesOr(CANCELLED_NULL_OUTCOME, `financial_outcome.not.in.(${TRIP_HISTORY_FINANCIAL_OUTCOMES.join(',')})`)).toBe(false);
  });

  it('shared SSOT agrees with the server filter for every fixture', () => {
    for (const r of FIXTURES) {
      const server = MISSED_CANCELLED_STATUSES.includes(r.status as never)
        && matchesAllOr(r, MISSED_CANCELLED_OWNERSHIP_OR_FILTERS);
      expect({ id: r.id, ssot: belongsInMissedCancelled(r as ClassRow) }).toEqual({ id: r.id, ssot: server });
    }
  });

  it('owned outcome lists stay identical across the Deno SSOT and the Admin query', () => {
    expect([...TRIP_HISTORY_OWNED_FINANCIAL_OUTCOMES]).toEqual([...TRIP_HISTORY_FINANCIAL_OUTCOMES]);
  });
});

describe('Missed & Cancelled counts and stats exclude Trip History outcomes', () => {
  it('list total, Cancelled and Missed stats count only owned rows', () => {
    const total = missedCancelledCount(FIXTURES, MISSED_CANCELLED_STATUSES);
    const cancelled = missedCancelledCount(FIXTURES, MISSED_CANCELLED_CANCELLED_STATUSES);
    const missed = missedCancelledCount(FIXTURES, MISSED_CANCELLED_MISSED_STATUSES);
    expect(total).toBe(MISSED_CANCELLED_ONLY.length);
    expect(cancelled).toBe(4);
    expect(missed).toBe(3);
    expect(cancelled + missed).toBe(total);
    expect(missedCancelledIds(FIXTURES).length).toBe(total);
  });

  it('status filters stay inside ownership', () => {
    expect(missedCancelledIds(FIXTURES, 'newest', 100, 'cancelled').sort())
      .toEqual([CANCELLED_NO_FEE.id, CANCELLED_NULL_OUTCOME.id, LEGACY_ARRIVAL_FLAG.id].sort());
    expect(missedCancelledIds(FIXTURES, 'newest', 100, 'expired').sort())
      .toEqual([EXPIRED.id, EXPIRED_NO_DRIVER.id].sort());
    expect(missedCancelledIds(FIXTURES, 'newest', 100, 'missed')).toEqual([MISSED.id]);
    expect(missedCancelledIds(FIXTURES, 'newest', 100, 'customer_cancelled')).toEqual([CUSTOMER_CANCELLED.id]);
  });
});

describe('Event-date sorting happens before pagination', () => {
  const thEventAt = (r: SimRow) => String(r.completed_at ?? r.cancelled_at ?? r.created_at);
  const mcEventAt = (r: SimRow) => String(missedCancelledEventAt(r as never));
  const expected = (rows: SimRow[], at: (r: SimRow) => string, order: AdminSortOrder) =>
    [...rows].sort((a, b) => {
      const d = eventTimestampMicros(at(a)) - eventTimestampMicros(at(b));
      const c = d !== 0 ? d : a.id < b.id ? -1 : 1;
      return order === 'oldest' ? c : -c;
    }).map((r) => r.id);

  const padding: SimRow[] = Array.from({ length: 140 }, (_, i) => row({
    id: `f${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`,
    status: i % 3 === 0 ? 'completed' : i % 3 === 1 ? 'cancelled' : 'expired',
    financial_outcome: i % 3 === 0 ? 'COMPLETED' : null,
    completed_at: i % 3 === 0 ? new Date(Date.UTC(2026, 8, 25, 1, i)).toISOString() : null,
    cancelled_at: i % 3 === 1 ? new Date(Date.UTC(2026, 8, 26, 2, i)).toISOString() : null,
    created_at: new Date(Date.UTC(2026, 8, 25, 0, i)).toISOString(),
  }));
  const all = [...FIXTURES, ...padding];

  for (const order of ['newest', 'oldest'] as const) {
    it(`Trip History ${order} first is the global event-date order at every page size`, () => {
      const owned = all.filter(tripHistoryScope);
      for (const size of [1, 7, 50, 100]) {
        expect(tripHistoryIds(all, order, size)).toEqual(expected(owned, thEventAt, order));
      }
    });

    it(`Missed & Cancelled ${order} first is the global event-date order at every page size`, () => {
      const owned = all.filter((r) => MISSED_CANCELLED_EVENT_BANDS.some((b) =>
        missedCancelledScope()(r, b) && (b.nullColumns.every((c) => r[c] == null) && r[b.column] != null)));
      for (const size of [1, 7, 50, 100]) {
        expect(missedCancelledIds(all, order, size)).toEqual(expected(owned, mcEventAt, order));
      }
    });
  }

  it('newest first is the default and 014 sorts by its cancellation time, not after completed trips', () => {
    const th = tripHistoryIds([MK_261002_014, COMPLETED, LATE]);
    expect(th).toEqual([MK_261002_014.id, COMPLETED.id, LATE.id]);
    expect(tripHistoryIds([MK_261002_014, COMPLETED, LATE], 'oldest')).toEqual([LATE.id, COMPLETED.id, MK_261002_014.id]);
  });

  it('cross-band microsecond ties never skip a row at a page boundary', () => {
    const tieA = row({ id: 'aaaaaaaa-0000-4000-8000-000000000001', status: 'cancelled', cancelled_at: '2026-10-02T12:29:40.350908+00:00', created_at: '2026-10-02T12:00:00+00:00' });
    const tieB = row({ id: 'aaaaaaaa-0000-4000-8000-000000000002', status: 'expired', created_at: '2026-10-02T12:29:40.3509+00:00' });
    const tieC = row({ id: 'aaaaaaaa-0000-4000-8000-000000000003', status: 'expired', created_at: '2026-10-02T12:29:40.350908+00:00' });
    for (const order of ['newest', 'oldest'] as const) {
      for (const size of [1, 2]) {
        const ids = missedCancelledIds([tieA, tieB, tieC], order, size);
        expect(new Set(ids)).toEqual(new Set([tieA.id, tieB.id, tieC.id]));
        expect(ids.length).toBe(3);
      }
    }
    expect(missedCancelledIds([tieA, tieB, tieC], 'newest', 1)).toEqual([tieC.id, tieA.id, tieB.id]);
  });
});

describe('Missed & Cancelled page wiring lock', () => {
  const src = readFileSync(resolve(__dirname, '../../pages/MissedCancelled.tsx'), 'utf8');

  it('scopes the list, the count and every stat query with the ownership filter', () => {
    const uses = src.match(/applyMissedCancelledOwnership\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(4);
    expect(src).toContain("select('id', { count: 'exact', head: true })");
    expect(src).not.toContain('MISSED_CANCELLED_STATS_EXTRA_STATUSES');
    expect(src).not.toMatch(/count:\s*'exact'\s*\}\)\s*\n\s*\.gte\('created_at'/);
  });

  it('windows and sorts on the event date in the query, before pagination', () => {
    expect(src).toContain('missedCancelledEventWindowOrFilter(start, end)');
    expect(src).toContain('applyEventBand(');
    expect(src).toContain('eventCursorOrFilter(band.column, pageCursor, sortOrder)');
    expect(src).toContain(".order(band.column, { ascending })");
    expect(src).toContain('mergeEventBandPages(');
    expect(src).not.toContain(".order('created_at', { ascending: false })\n          .range(");
    expect(src).toContain('<SelectItem value="newest">Newest first</SelectItem>');
    expect(src).toContain('<SelectItem value="oldest">Oldest first</SelectItem>');
  });

  it('no longer reports chargeable terminal outcomes as Missed & Cancelled stats', () => {
    expect(src).not.toContain('Chargeable outcomes');
    expect(src).not.toContain('No-Show: {bucketStats.no_show}');
  });
});
