/**
 * Minimal in-memory model of the PostgREST behaviour the Admin trip lists use:
 * logic-tree filters, ORDER BY (event date, id), LIMIT pageSize + 1 keyset pages
 * and offset ranges. Computed columns are materialised from the TS mirrors of
 * the SQL functions before filtering, exactly as the database evaluates them.
 */
import {
  MISSED_CANCELLED_EVENT_AT_COLUMN,
  TRIP_HISTORY_EVENT_AT_COLUMN,
  adminTripDateSortAscending,
  missedCancelledEventAt,
  tripHistoryEventAt,
  type AdminTripDateSort,
} from '@/lib/adminTripListDateSort';
import { tripHistoryCursorOrFilter, type TripHistoryCursor } from '@/lib/tripHistoryQuery';
import { missedCancelledPageRange } from '@/lib/missedCancelledPagination';

export type SimRow = Record<string, unknown> & { id: string };

export function splitTopLevel(filter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of filter) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

function compare(cell: unknown, value: string): number {
  const a = Number(cell);
  const b = Number(value);
  if (typeof cell === 'number' && Number.isFinite(b)) return a - b;
  const sa = String(cell);
  return sa < value ? -1 : sa > value ? 1 : 0;
}

export function evalTerm(row: SimRow, term: string): boolean {
  if (term.startsWith('and(') && term.endsWith(')')) {
    return splitTopLevel(term.slice(4, -1)).every((t) => evalTerm(row, t));
  }
  const firstDot = term.indexOf('.');
  const secondDot = term.indexOf('.', firstDot + 1);
  const col = term.slice(0, firstDot);
  const op = term.slice(firstDot + 1, secondDot);
  const value = term.slice(secondDot + 1);
  const cell = row[col];
  if (op === 'is' && value === 'null') return cell === null || cell === undefined;
  if (cell === null || cell === undefined) return false;
  if (op === 'eq') return String(cell) === value;
  if (op === 'in') return value.slice(1, -1).split(',').includes(String(cell));
  if (op === 'gt') return compare(cell, value) > 0;
  if (op === 'lt') return compare(cell, value) < 0;
  if (op === 'gte') return compare(cell, value) >= 0;
  if (op === 'lte') return compare(cell, value) <= 0;
  throw new Error(`unsupported term ${term}`);
}

export const matchesOr = (row: SimRow, filter: string): boolean =>
  splitTopLevel(filter).some((t) => evalTerm(row, t));

export function withEventColumns(row: SimRow): SimRow {
  return {
    ...row,
    [TRIP_HISTORY_EVENT_AT_COLUMN]: tripHistoryEventAt(row as Parameters<typeof tripHistoryEventAt>[0]),
    [MISSED_CANCELLED_EVENT_AT_COLUMN]: missedCancelledEventAt(row as Parameters<typeof missedCancelledEventAt>[0]),
  };
}

/** ORDER BY <column> <dir>, id <dir> — the database order, not a client re-sort. */
export function orderByEventThenId(rows: SimRow[], column: string, sort: AdminTripDateSort): SimRow[] {
  const dir = adminTripDateSortAscending(sort) ? 1 : -1;
  return [...rows].sort((a, b) => {
    const ea = String(a[column]);
    const eb = String(b[column]);
    if (ea !== eb) return (ea < eb ? -1 : 1) * dir;
    return (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * dir;
  });
}

/** Trip History keyset pages exactly as fetchTripHistoryPage requests them. */
export function tripHistoryKeysetPages(rows: SimRow[], pageSize: number, sort: AdminTripDateSort): string[][] {
  const table = rows.map(withEventColumns);
  const pages: string[][] = [];
  let cursor: TripHistoryCursor | null = null;
  for (let guard = 0; guard < 1000; guard += 1) {
    const filtered = cursor ? table.filter((row) => matchesOr(row, tripHistoryCursorOrFilter(cursor!))) : table;
    const fetched = orderByEventThenId(filtered, TRIP_HISTORY_EVENT_AT_COLUMN, sort).slice(0, pageSize + 1);
    const pageRows = fetched.slice(0, pageSize);
    if (pageRows.length) pages.push(pageRows.map((r) => r.id));
    if (fetched.length <= pageSize) break;
    const last = pageRows[pageRows.length - 1];
    cursor = { id: last.id, eventAt: String(last[TRIP_HISTORY_EVENT_AT_COLUMN]), sort };
  }
  return pages;
}

/** Missed & Cancelled offset pages: ORDER BY event, id then .range(from, to). */
export function missedCancelledOffsetPages(rows: SimRow[], pageSize: number, sort: AdminTripDateSort): string[][] {
  const ordered = orderByEventThenId(rows.map(withEventColumns), MISSED_CANCELLED_EVENT_AT_COLUMN, sort);
  const pages: string[][] = [];
  for (let page = 0; ; page += 1) {
    const { from, to } = missedCancelledPageRange(page, pageSize);
    const slice = ordered.slice(from, to + 1);
    if (!slice.length) break;
    pages.push(slice.map((r) => r.id));
  }
  return pages;
}
