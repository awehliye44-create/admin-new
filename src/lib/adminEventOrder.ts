/**
 * Event-time ordering for Admin lists whose event date is a COALESCE of columns
 * (e.g. completed_at ?? cancelled_at ?? created_at). PostgREST cannot ORDER BY an
 * expression, so the owned set is split into disjoint bands — one per source column —
 * each ordered by the database on that column, then merged on a shared
 * (event_at, id) keyset before the page is cut.
 */

export type AdminSortOrder = 'newest' | 'oldest';

export const ADMIN_SORT_ORDER_DEFAULT: AdminSortOrder = 'newest';

export type AdminEventCursor = {
  eventAt: string;
  id: string;
};

/** A band owns rows where `column` is set and every `nullColumns` entry is NULL. */
export type AdminEventBand = {
  column: string;
  nullColumns: readonly string[];
};

type BandQuery<Q> = {
  is: (column: string, value: null) => Q;
  not: (column: string, operator: string, value: null) => Q;
};

export function applyEventBand<Q extends BandQuery<Q>>(query: Q, band: AdminEventBand): Q {
  let q = query.not(band.column, 'is', null);
  for (const column of band.nullColumns) q = q.is(column, null);
  return q;
}

function isSet(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

export function rowInEventBand(row: Record<string, unknown>, band: AdminEventBand): boolean {
  return isSet(row[band.column]) && band.nullColumns.every((column) => !isSet(row[column]));
}

export function eventKeyForBands(
  row: Record<string, unknown> & { id: string },
  bands: readonly AdminEventBand[],
): AdminEventCursor | null {
  const band = bands.find((b) => rowInEventBand(row, b));
  if (!band) return null;
  return { eventAt: String(row[band.column]), id: row.id };
}

const ISO_TS = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * Epoch microseconds. Postgres timestamptz carries microseconds and PostgREST trims
 * trailing zeros, so neither Date.parse (ms) nor string comparison orders ties exactly —
 * and a cross-band misorder at a page boundary would skip a row.
 */
export function eventTimestampMicros(value: string): number {
  const m = ISO_TS.exec(value.trim());
  if (!m) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms * 1000 : Number.NaN;
  }
  let tz = (m[4] ?? 'Z').toUpperCase();
  if (/^[+-]\d{2}$/.test(tz)) tz = `${tz}:00`;
  else if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
  const secondsMs = Date.parse(`${m[1]}T${m[2]}${tz}`);
  const micros = Number((m[3] ?? '').padEnd(6, '0').slice(0, 6));
  return secondsMs * 1000 + micros;
}

export function compareEventKeys(
  a: AdminEventCursor,
  b: AdminEventCursor,
  order: AdminSortOrder,
): number {
  const dir = order === 'oldest' ? 1 : -1;
  const ta = eventTimestampMicros(a.eventAt);
  const tb = eventTimestampMicros(b.eventAt);
  if (ta !== tb) return (ta < tb ? -1 : 1) * dir;
  if (a.id === b.id) return 0;
  return (a.id < b.id ? -1 : 1) * dir;
}

/** Keyset continuation inside one band: strictly after the cursor in the chosen order. */
export function eventCursorOrFilter(
  column: string,
  cursor: AdminEventCursor,
  order: AdminSortOrder,
): string {
  const op = order === 'oldest' ? 'gt' : 'lt';
  return `${column}.${op}.${cursor.eventAt},and(${column}.eq.${cursor.eventAt},id.${op}.${cursor.id})`;
}

export type MergedEventPage<T> = {
  rows: T[];
  hasMore: boolean;
  nextCursor: AdminEventCursor | null;
};

/**
 * Each band must be fetched with the same cursor and `limit(pageSize + 1)`. Every row
 * in the global top `pageSize` is inside its own band's top `pageSize`, and the union
 * exceeds `pageSize` exactly when more rows remain.
 */
export function mergeEventBandPages<T>(
  bandRows: readonly T[][],
  keyOf: (row: T) => AdminEventCursor,
  order: AdminSortOrder,
  pageSize: number,
): MergedEventPage<T> {
  const merged = bandRows.flat().sort((a, b) => compareEventKeys(keyOf(a), keyOf(b), order));
  const rows = merged.slice(0, pageSize);
  const hasMore = merged.length > pageSize;
  const last = rows[rows.length - 1];
  return { rows, hasMore, nextCursor: hasMore && last ? keyOf(last) : null };
}
