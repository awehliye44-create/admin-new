/**
 * Test-only PostgREST simulator: evaluates the exact or-filter strings the Admin pages
 * send, and replays banded keyset pagination with database semantics (NULL never
 * satisfies a comparison, timestamps compare at microsecond precision).
 */
import {
  eventCursorOrFilter,
  eventKeyForBands,
  eventTimestampMicros,
  mergeEventBandPages,
  rowInEventBand,
  type AdminEventBand,
  type AdminEventCursor,
  type AdminSortOrder,
} from '../../adminEventOrder';

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

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

function compareCell(cell: unknown, value: string): number {
  if (typeof cell === 'number') return cell - Number(value);
  const text = String(cell);
  if (ISO_LIKE.test(text) && ISO_LIKE.test(value)) {
    return eventTimestampMicros(text) - eventTimestampMicros(value);
  }
  return text < value ? -1 : text > value ? 1 : 0;
}

export function evalTerm(row: SimRow, term: string): boolean {
  if (term.startsWith('and(') && term.endsWith(')')) {
    return splitTopLevel(term.slice(4, -1)).every((t) => evalTerm(row, t));
  }
  const firstDot = term.indexOf('.');
  const col = term.slice(0, firstDot);
  let rest = term.slice(firstDot + 1);
  let negate = false;
  if (rest.startsWith('not.')) {
    negate = true;
    rest = rest.slice(4);
  }
  const opDot = rest.indexOf('.');
  const op = rest.slice(0, opDot);
  const value = rest.slice(opDot + 1);
  const cell = row[col];
  const isNull = cell === null || cell === undefined;

  if (op === 'is' && value === 'null') return negate ? !isNull : isNull;
  // SQL three-valued logic: any comparison with NULL is unknown, and NOT unknown is unknown.
  if (isNull) return false;

  let result: boolean;
  switch (op) {
    case 'eq': result = compareCell(cell, value) === 0; break;
    case 'neq': result = compareCell(cell, value) !== 0; break;
    case 'gt': result = compareCell(cell, value) > 0; break;
    case 'gte': result = compareCell(cell, value) >= 0; break;
    case 'lt': result = compareCell(cell, value) < 0; break;
    case 'lte': result = compareCell(cell, value) <= 0; break;
    case 'in': result = value.slice(1, -1).split(',').includes(String(cell)); break;
    case 'ilike': {
      const pattern = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*');
      result = new RegExp(`^${pattern}$`, 'i').test(String(cell));
      break;
    }
    default: throw new Error(`unsupported term ${term}`);
  }
  return negate ? !result : result;
}

export const matchesOr = (row: SimRow, filter: string): boolean =>
  splitTopLevel(filter).some((t) => evalTerm(row, t));

export const matchesAllOr = (row: SimRow, filters: readonly string[]): boolean =>
  filters.every((f) => matchesOr(row, f));

function dbOrder(column: string, order: AdminSortOrder) {
  const dir = order === 'oldest' ? 1 : -1;
  return (a: SimRow, b: SimRow): number => {
    const ta = eventTimestampMicros(String(a[column]));
    const tb = eventTimestampMicros(String(b[column]));
    if (ta !== tb) return (ta < tb ? -1 : 1) * dir;
    return (a.id < b.id ? -1 : 1) * dir;
  };
}

/** One page exactly as the Admin fetchers build it: per-band query, then merge. */
export function simulateBandedPage(
  rows: readonly SimRow[],
  bands: readonly AdminEventBand[],
  scope: (row: SimRow, band: AdminEventBand) => boolean,
  cursor: AdminEventCursor | null,
  order: AdminSortOrder,
  pageSize: number,
) {
  const bandRows = bands.map((band) =>
    rows
      .filter((row) => rowInEventBand(row, band) && scope(row, band))
      .filter((row) => !cursor || matchesOr(row, eventCursorOrFilter(band.column, cursor, order)))
      .sort(dbOrder(band.column, order))
      .slice(0, pageSize + 1),
  );
  return mergeEventBandPages(
    bandRows,
    (row) => eventKeyForBands(row, bands) as AdminEventCursor,
    order,
    pageSize,
  );
}

/** Walks every page; returns ids in display order. */
export function simulateAllPages(
  rows: readonly SimRow[],
  bands: readonly AdminEventBand[],
  scope: (row: SimRow, band: AdminEventBand) => boolean,
  order: AdminSortOrder,
  pageSize: number,
): string[] {
  const seen: string[] = [];
  let cursor: AdminEventCursor | null = null;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const page = simulateBandedPage(rows, bands, scope, cursor, order, pageSize);
    seen.push(...page.rows.map((r) => r.id));
    if (!page.hasMore) return seen;
    cursor = page.nextCursor;
  }
  throw new Error('pagination did not terminate');
}
