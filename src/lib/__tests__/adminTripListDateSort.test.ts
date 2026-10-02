import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { endOfDay, startOfDay, subDays } from 'date-fns';
import { describe, expect, it } from 'vitest';
import { adminTripHistoryDisplayAt, belongsInMissedCancelled } from '../adminTripNoShowClassification';
import {
  ADMIN_TRIP_DATE_SORT_DEFAULT,
  ADMIN_TRIP_DATE_SORT_OPTIONS,
  missedCancelledEventAt,
  parseAdminTripDateSort,
  tripHistoryEventAt,
  type AdminTripDateSort,
} from '../adminTripListDateSort';
import { missedCancelledHasNextPage, missedCancelledPageRange } from '../missedCancelledPagination';
import { tripHistoryDateOrFilter, tripHistoryTerminalOrFilter } from '../tripHistoryQuery';
import {
  matchesOr,
  missedCancelledOffsetPages,
  tripHistoryKeysetPages,
  withEventColumns,
  type SimRow,
} from '../../test/tripListPostgrestSim';

const NOW = new Date('2026-10-02T17:00:00.000Z');

type EventRow = {
  status?: string | null;
  financial_outcome?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
  created_at?: string | null;
};
const SORTS: AdminTripDateSort[] = ['newest', 'oldest'];

const at = (hhmm: string, day = '2026-10-02') => `${day}T${hhmm}:00.000Z`;

/** Trip History query pipeline: terminal OR + date window OR, then keyset pages. */
function tripHistoryPages(rows: SimRow[], days: number, pageSize: number, sort: AdminTripDateSort): string[][] {
  const start = startOfDay(subDays(NOW, days));
  const end = endOfDay(NOW);
  const terminal = tripHistoryTerminalOrFilter('all');
  const window = tripHistoryDateOrFilter(start, end);
  const base = rows.filter((row) => matchesOr(row, terminal) && matchesOr(row, window));
  return tripHistoryKeysetPages(base, pageSize, sort);
}

function inTripHistoryWindow(rows: SimRow[], days: number): SimRow[] {
  const start = startOfDay(subDays(NOW, days));
  const end = endOfDay(NOW);
  return rows.filter(
    (row) => matchesOr(row, tripHistoryTerminalOrFilter('all'))
      && matchesOr(row, tripHistoryDateOrFilter(start, end)),
  );
}

/** Independent oracle: event date then id, written without the production helpers. */
function oracle(rows: SimRow[], key: (r: SimRow) => string, sort: AdminTripDateSort): string[] {
  const dir = sort === 'oldest' ? 1 : -1;
  return [...rows]
    .sort((a, b) => (key(a) === key(b) ? (a.id < b.id ? -1 : 1) : key(a) < key(b) ? -1 : 1) * dir)
    .map((r) => r.id);
}
const historyKey = (r: SimRow) => String(r.completed_at ?? r.cancelled_at ?? r.created_at);
const missedKey = (r: SimRow) => String(r.cancelled_at ?? r.created_at);

const completed = (id: string, time: string): SimRow => ({
  id,
  status: 'completed',
  financial_outcome: 'COMPLETED',
  completed_at: time,
  cancelled_at: null,
  created_at: time.replace(/T(\d\d)/, (_m, h) => `T${String(Math.max(0, Number(h) - 1)).padStart(2, '0')}`),
});
const terminal = (id: string, outcome: string, time: string, status = 'cancelled'): SimRow => ({
  id,
  status,
  financial_outcome: outcome,
  completed_at: null,
  cancelled_at: time,
  created_at: time.replace(/T(\d\d)/, (_m, h) => `T${String(Math.max(0, Number(h) - 1)).padStart(2, '0')}`),
});

describe('canonical event date', () => {
  it('Trip History: completed_at, else terminal cancelled_at, else created_at — never manufactures completed_at', () => {
    expect(tripHistoryEventAt({ completed_at: at('16:00'), cancelled_at: null, created_at: at('15:00') })).toBe(at('16:00'));
    expect(tripHistoryEventAt({ completed_at: null, cancelled_at: at('15:55'), created_at: at('15:30') })).toBe(at('15:55'));
    expect(tripHistoryEventAt({ completed_at: null, cancelled_at: null, created_at: at('15:30') })).toBe(at('15:30'));
  });

  it('Missed & Cancelled: cancelled_at, else created_at', () => {
    expect(missedCancelledEventAt({ cancelled_at: at('16:10'), created_at: at('16:00') })).toBe(at('16:10'));
    expect(missedCancelledEventAt({ cancelled_at: null, created_at: at('16:00') })).toBe(at('16:00'));
  });

  it('default is Newest first; only "oldest" selects ascending', () => {
    expect(ADMIN_TRIP_DATE_SORT_DEFAULT).toBe('newest');
    expect(ADMIN_TRIP_DATE_SORT_OPTIONS.map((o) => o.label)).toEqual(['Newest first', 'Oldest first']);
    expect(parseAdminTripDateSort('oldest')).toBe('oldest');
    expect(parseAdminTripDateSort(undefined)).toBe('newest');
    expect(parseAdminTripDateSort('anything')).toBe('newest');
  });
});

describe('Trip History mixed outcomes with NULL completed_at', () => {
  const rows: SimRow[] = [
    completed('t-1600-completed', at('16:00')),
    terminal('t-1555-arrival', 'ARRIVAL_CANCELLATION', at('15:55')),
    terminal('t-1550-noshow', 'NO_SHOW', at('15:50'), 'no_show'),
    terminal('t-1545-late', 'LATE_PASSENGER_CANCELLATION', at('15:45')),
    completed('t-1540-completed', at('15:40')),
  ];
  const shuffled = [rows[3], rows[0], rows[4], rows[1], rows[2]];

  it('Newest first: 16:00, 15:55, 15:50, 15:45, 15:40', () => {
    const ids = tripHistoryPages(shuffled, 7, 50, 'newest').flat();
    expect(ids).toEqual(rows.map((r) => r.id));
  });

  it('Oldest first: 15:40, 15:45, 15:50, 15:55, 16:00', () => {
    const ids = tripHistoryPages(shuffled, 7, 50, 'oldest').flat();
    expect(ids).toEqual(rows.map((r) => r.id).reverse());
  });

  it('displayed date equals the date that positioned the row', () => {
    for (const row of rows as EventRow[]) {
      expect(adminTripHistoryDisplayAt(row)).toBe(tripHistoryEventAt(row));
    }
  });
});

describe('Trip History page boundaries', () => {
  const rows51: SimRow[] = Array.from({ length: 51 }, (_, i) =>
    i % 3 === 0
      ? terminal(`r-${String(i).padStart(3, '0')}`, 'ARRIVAL_CANCELLATION', new Date(Date.UTC(2026, 9, 2, 8, i)).toISOString())
      : completed(`r-${String(i).padStart(3, '0')}`, new Date(Date.UTC(2026, 9, 2, 8, i)).toISOString()),
  );

  it('51 rows / page 50 — Newest first: newest 50 on page 1, the oldest alone on page 2', () => {
    const pages = tripHistoryPages(rows51, 7, 50, 'newest');
    expect(pages.map((p) => p.length)).toEqual([50, 1]);
    expect(pages[0][0]).toBe('r-050');
    expect(pages[0][49]).toBe('r-001');
    expect(pages[1]).toEqual(['r-000']);
  });

  it('51 rows / page 50 — Oldest first: oldest 50 on page 1, the newest alone on page 2', () => {
    const pages = tripHistoryPages(rows51, 7, 50, 'oldest');
    expect(pages.map((p) => p.length)).toEqual([50, 1]);
    expect(pages[0][0]).toBe('r-000');
    expect(pages[1]).toEqual(['r-050']);
  });

  it('101 rows / page 100 splits 100 + 1 in both directions', () => {
    const rows101 = Array.from({ length: 101 }, (_, i) =>
      completed(`s-${String(i).padStart(3, '0')}`, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString()),
    );
    expect(tripHistoryPages(rows101, 7, 100, 'newest').map((p) => p.length)).toEqual([100, 1]);
    expect(tripHistoryPages(rows101, 7, 100, 'newest')[1]).toEqual(['s-000']);
    expect(tripHistoryPages(rows101, 7, 100, 'oldest')[1]).toEqual(['s-100']);
  });

  it('equal timestamps across a page boundary are resolved by id with no duplicates or gaps', () => {
    const tie = '2026-10-02T09:00:00.000Z';
    const rows = Array.from({ length: 120 }, (_, i) =>
      i % 2 === 0
        ? completed(`tie-${String(i).padStart(3, '0')}`, tie)
        : terminal(`tie-${String(i).padStart(3, '0')}`, 'NO_SHOW', tie, 'no_show'),
    );
    for (const size of [50, 100]) {
      for (const sort of SORTS) {
        const ids = tripHistoryPages(rows, 7, size, sort).flat();
        expect(ids).toEqual(oracle(rows, historyKey, sort));
      }
    }
  });
});

describe('Trip History 7 / 30 / 90 days × page 50 / 100 × both directions', () => {
  const kinds = ['completed', 'arrival', 'noshow', 'late', 'free_cancel'] as const;
  const rows: SimRow[] = [];
  for (let d = 0; d < 120; d += 1) {
    kinds.forEach((kind, k) => {
      const time = new Date(NOW.getTime() - d * 86_400_000 - (k * 7 + (d % 5)) * 60_000).toISOString();
      const id = `d${String(d).padStart(3, '0')}-${kind}`;
      if (kind === 'completed') rows.push(completed(id, time));
      if (kind === 'arrival') rows.push(terminal(id, 'ARRIVAL_CANCELLATION', time));
      if (kind === 'noshow') rows.push(terminal(id, 'NO_SHOW', time, 'no_show'));
      if (kind === 'late') rows.push(terminal(id, 'LATE_PASSENGER_CANCELLATION', time));
      if (kind === 'free_cancel') rows.push(terminal(id, 'CANCELLED_NO_FEE', time));
    });
    if (d % 10 === 0) {
      const shared = new Date(NOW.getTime() - d * 86_400_000 - 3 * 3_600_000).toISOString();
      rows.push(completed(`d${String(d).padStart(3, '0')}-tie-a`, shared));
      rows.push(terminal(`d${String(d).padStart(3, '0')}-tie-b`, 'ARRIVAL_CANCELLATION', shared));
    }
  }

  for (const days of [7, 30, 90]) {
    for (const size of [50, 100]) {
      for (const sort of SORTS) {
        it(`${days}d / ${size} / ${sort}: complete, unique, ordered, correct page sizes`, () => {
          const expected = oracle(inTripHistoryWindow(rows, days), historyKey, sort);
          const pages = tripHistoryPages(rows, days, size, sort);
          const ids = pages.flat();
          expect(ids).toEqual(expected);
          expect(new Set(ids).size).toBe(ids.length);
          pages.slice(0, -1).forEach((page) => expect(page.length).toBe(size));
          expect(ids.some((id) => id.endsWith('free_cancel'))).toBe(false);
          expect(ids.some((id) => id.endsWith('arrival'))).toBe(true);
          expect(ids.some((id) => id.endsWith('noshow'))).toBe(true);
          expect(ids.some((id) => id.endsWith('late'))).toBe(true);
        });
      }
    }
  }

  it('Newest first page 1 starts with the newest terminal trip of the window', () => {
    const first = tripHistoryPages(rows, 7, 50, 'newest')[0][0];
    expect(first).toBe(oracle(inTripHistoryWindow(rows, 7), historyKey, 'newest')[0]);
    expect(first.startsWith('d000-')).toBe(true);
  });
});

describe('MK-261002-014 / MK-261002-015 / Late Passenger positioned by terminal event date', () => {
  const r014 = terminal('118fe5ef-4e2e-4d48-814f-31b65839225b', 'ARRIVAL_CANCELLATION', '2026-10-02T12:29:40.350Z');
  const r015 = terminal('98cab445-aa22-401a-8aac-e53210990273', 'NO_SHOW', '2026-10-02T12:43:36.989Z', 'no_show');
  const late = terminal('late-passenger', 'LATE_PASSENGER_CANCELLATION', '2026-10-02T12:36:00.000Z');
  const completions = Array.from({ length: 60 }, (_, i) =>
    completed(`c-${String(i).padStart(2, '0')}`, new Date(Date.UTC(2026, 9, 2, 12, i)).toISOString()),
  );
  const rows = [...completions, r014, r015, late];

  it('014 sits between the 12:30 and 12:29 completions (Newest first), not at the bottom', () => {
    const ids = tripHistoryPages(rows, 7, 50, 'newest').flat();
    const i = ids.indexOf(r014.id);
    expect(ids[i - 1]).toBe('c-30');
    expect(ids[i + 1]).toBe('c-29');
    expect(i).toBeLessThan(ids.length - 1);
  });

  it('015 sits between the 12:44 and 12:43 completions (Newest first)', () => {
    const ids = tripHistoryPages(rows, 7, 50, 'newest').flat();
    const i = ids.indexOf(r015.id);
    expect(ids[i - 1]).toBe('c-44');
    expect(ids[i + 1]).toBe('c-43');
  });

  it('Late Passenger Cancellation sits between the 12:36 and 12:35 completions', () => {
    const ids = tripHistoryPages(rows, 7, 50, 'newest').flat();
    const i = ids.indexOf(late.id);
    // Same timestamp as c-36: the id tie-breaker ('late-passenger' > 'c-36') places it first when DESC.
    expect(ids[i + 1]).toBe('c-36');
    expect(ids[i - 1]).toBe('c-37');
  });

  it('Oldest first is the exact reverse, across page sizes 50 and 100', () => {
    for (const size of [50, 100]) {
      const newest = tripHistoryPages(rows, 7, size, 'newest').flat();
      const oldest = tripHistoryPages(rows, 7, size, 'oldest').flat();
      expect(oldest).toEqual([...newest].reverse());
      expect(newest.length).toBe(rows.length);
    }
  });
});

describe('Missed & Cancelled ordering and offset pages', () => {
  const statuses = ['cancelled', 'customer_cancelled', 'missed', 'expired', 'expired_no_driver'];
  const rows: SimRow[] = Array.from({ length: 251 }, (_, i) => {
    const created = new Date(NOW.getTime() - i * 37 * 60_000).toISOString();
    const status = statuses[i % statuses.length];
    const cancelled = status.startsWith('expired') || status === 'missed'
      ? null
      : new Date(NOW.getTime() - i * 37 * 60_000 + 9 * 60_000).toISOString();
    return { id: `m-${String(i).padStart(3, '0')}`, status, created_at: created, cancelled_at: cancelled, completed_at: null };
  });

  it('every fixture belongs on the page (membership unchanged by sorting)', () => {
    expect((rows as EventRow[]).every((r) => belongsInMissedCancelled(r))).toBe(true);
  });

  for (const size of [50, 100]) {
    for (const sort of SORTS) {
      it(`page ${size} / ${sort}: complete, unique, ordered by cancelled_at else created_at`, () => {
        const pages = missedCancelledOffsetPages(rows, size, sort);
        const ids = pages.flat();
        expect(ids).toEqual(oracle(rows, missedKey, sort));
        expect(new Set(ids).size).toBe(rows.length);
        pages.slice(0, -1).forEach((page) => expect(page.length).toBe(size));
      });
    }
  }

  it('51 rows / page 50: newest 50 then the oldest; reversed for Oldest first', () => {
    const subset = rows.slice(0, 51);
    const newest = missedCancelledOffsetPages(subset, 50, 'newest');
    expect(newest.map((p) => p.length)).toEqual([50, 1]);
    expect(newest[0][0]).toBe(oracle(subset, missedKey, 'newest')[0]);
    expect(newest[1]).toEqual([oracle(subset, missedKey, 'newest')[50]]);
    const oldest = missedCancelledOffsetPages(subset, 50, 'oldest');
    expect(oldest[1]).toEqual([oracle(subset, missedKey, 'oldest')[50]]);
  });

  it('a booking created earlier but cancelled latest is shown first (Newest first)', () => {
    const lateCancel: SimRow = {
      id: 'late-cancel', status: 'cancelled',
      created_at: '2026-09-20T08:00:00.000Z', cancelled_at: '2026-10-02T17:30:00.000Z', completed_at: null,
    };
    const first = missedCancelledOffsetPages([...rows, lateCancel], 100, 'newest')[0][0];
    expect(first).toBe('late-cancel');
    expect(withEventColumns(lateCancel).missed_cancelled_event_at).toBe('2026-10-02T17:30:00.000Z');
  });

  it('range and Next use the server count, not rows left after client filtering', () => {
    expect(missedCancelledPageRange(0, 100)).toEqual({ from: 0, to: 99 });
    expect(missedCancelledPageRange(2, 50)).toEqual({ from: 100, to: 149 });
    expect(missedCancelledHasNextPage(0, 50, 51)).toBe(true);
    expect(missedCancelledHasNextPage(1, 50, 51)).toBe(false);
    expect(missedCancelledHasNextPage(0, 100, 100)).toBe(false);
    expect(missedCancelledHasNextPage(0, 100, 101)).toBe(true);
  });
});

describe('wiring locks — database order before limit / range, no client page re-sort', () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');
  const query = read('../tripHistoryQuery.ts');
  const history = read('../../pages/TripHistory.tsx');
  const missed = read('../../pages/MissedCancelled.tsx');
  const sql = read('../../../supabase/migrations/20261206120000_admin_trip_list_event_date_sort.sql');

  it('Trip History orders on the event-date column then id, before the page limit', () => {
    const order = query.indexOf('.order(TRIP_HISTORY_EVENT_AT_COLUMN, { ascending })');
    const tie = query.indexOf(".order('id', { ascending })");
    const limit = query.indexOf('.limit(pageSize + 1)');
    expect(order).toBeGreaterThan(-1);
    expect(tie).toBeGreaterThan(order);
    expect(limit).toBeGreaterThan(tie);
    expect(query).not.toContain(".order('completed_at'");
    expect(query).toContain('${TRIP_HISTORY_EVENT_AT_COLUMN}, cancellation_reason');
  });

  it('Missed & Cancelled orders on the event-date column then id, before .range(from, to)', () => {
    const order = missed.indexOf('.order(MISSED_CANCELLED_EVENT_AT_COLUMN, { ascending })');
    const tie = missed.indexOf(".order('id', { ascending })", order);
    const range = missed.indexOf('.range(from, to)');
    expect(order).toBeGreaterThan(-1);
    expect(tie).toBeGreaterThan(order);
    expect(range).toBeGreaterThan(tie);
    expect(missed).toContain('formatFinanceDateSafe(missedCancelledEventAt(trip)');
  });

  it('both pages default to Newest first, key queries on the sort and never re-sort rows', () => {
    for (const page of [history, missed]) {
      expect(page).toContain('useState<AdminTripDateSort>(ADMIN_TRIP_DATE_SORT_DEFAULT)');
      expect(page).toContain('aria-label="Sort by date"');
      expect(page).toContain('ADMIN_TRIP_DATE_SORT_OPTIONS.map');
      expect(page).not.toContain('sortTripHistoryRows(');
    }
    expect(history).toContain('sort: dateSort,');
    expect(history.match(/sort: dateSort,/g)?.length).toBe(2);
    expect(missed).toContain('debouncedSearch, dateSort]');
  });

  it('SQL computed columns match the TS resolvers and write nothing', () => {
    expect(sql).toContain('select coalesce(t.completed_at, t.cancelled_at, t.created_at)');
    expect(sql).toContain('select coalesce(t.cancelled_at, t.created_at)');
    expect(sql).toMatch(/function public\.trip_history_event_at\(t public\.trips\)/);
    expect(sql).toMatch(/function public\.missed_cancelled_event_at\(t public\.trips\)/);
    expect(sql.toLowerCase()).not.toMatch(/\b(update|insert|delete)\b\s+(into\s+)?(public\.)?\w+/);
  });
});
