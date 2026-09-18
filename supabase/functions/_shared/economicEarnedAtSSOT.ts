/**
 * Consume-only economic earning-date helpers.
 *
 * Production resolution is SQL `driver_wallet_resolve_economic_date`.
 * This module buckets/parses backend-resolved fields. It does not join
 * Payment Sessions or decide captured_at.
 *
 * posting_created_at = driver_wallet_ledger.created_at (immutable)
 * economic_earned_at = backend-resolved RIDE_BOOKING captured_at or null
 */

export const LEDGER_TYPE_TRIP_EARNING_NET = "TRIP_EARNING_NET";

export const ECONOMIC_DATE_STATUS = {
  RESOLVED: "RESOLVED",
  POSTING_CREATED_AT: "POSTING_CREATED_AT",
  PAYMENT_SESSION_MISSING: "PAYMENT_SESSION_MISSING",
  CAPTURE_TIMESTAMP_MISSING: "CAPTURE_TIMESTAMP_MISSING",
  CAPTURE_AMBIGUOUS: "CAPTURE_AMBIGUOUS",
  CAPTURE_REFUNDED: "CAPTURE_REFUNDED",
  CAPTURE_RELEASED: "CAPTURE_RELEASED",
  FINANCIAL_MODEL_MISMATCH: "FINANCIAL_MODEL_MISMATCH",
  CAPTURE_NOT_VERIFIED: "CAPTURE_NOT_VERIFIED",
} as const;

export type EconomicDateStatus =
  (typeof ECONOMIC_DATE_STATUS)[keyof typeof ECONOMIC_DATE_STATUS];

export const ECONOMIC_EARNED_AT_CREATED_AT_LOOKAROUND_MS =
  45 * 24 * 60 * 60 * 1000;

export type BackendEconomicFields = {
  ledger_entry_id?: string | null;
  related_trip_id?: string | null;
  amount_pence?: number | null;
  type?: string | null;
  description?: string | null;
  posting_created_at?: string | null;
  created_at?: string | null;
  economic_earned_at?: string | null;
  economic_date_status?: string | null;
  captured_at?: string | null;
  eligible_at?: string | null;
  clearing_status?: string | null;
};

function upper(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function isUnresolvedEconomicDate(status: string | null | undefined): boolean {
  const s = upper(status);
  return s !== ECONOMIC_DATE_STATUS.RESOLVED && s !== ECONOMIC_DATE_STATUS.POSTING_CREATED_AT && s !== "";
}

/** Inclusive start, exclusive end. */
export function isInstantInHalfOpenRange(
  iso: string | null | undefined,
  startIso: string,
  endIso: string,
): boolean {
  const t = parseIsoMs(iso);
  const start = parseIsoMs(startIso);
  const end = parseIsoMs(endIso);
  if (t == null || start == null || end == null) return false;
  return t >= start && t < end;
}

/** Inclusive start and end (admin widget period bounds). */
export function isInstantInClosedRange(
  iso: string | null | undefined,
  fromIso: string,
  toIso: string,
): boolean {
  const t = parseIsoMs(iso);
  const from = parseIsoMs(fromIso);
  const to = parseIsoMs(toIso);
  if (t == null || from == null || to == null) return false;
  return t >= from && t <= to;
}

export function londonCivilDateKey(iso: string | null | undefined): string | null {
  const ms = parseIsoMs(iso);
  if (ms == null) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

export function padCreatedAtLookaround(
  startIso: string,
  endIso: string,
  lookaroundMs: number = ECONOMIC_EARNED_AT_CREATED_AT_LOOKAROUND_MS,
): { fetchStartIso: string; fetchEndIso: string } {
  const start = parseIsoMs(startIso) ?? 0;
  const end = parseIsoMs(endIso) ?? 0;
  return {
    fetchStartIso: new Date(start - lookaroundMs).toISOString(),
    fetchEndIso: new Date(end + lookaroundMs).toISOString(),
  };
}

/**
 * Period attribution instant for earnings buckets.
 * TEN with null economic_earned_at is fail-closed (never created_at).
 */
export function earningsAttributionInstant(row: {
  type?: string | null;
  created_at?: string | null;
  posting_created_at?: string | null;
  economic_earned_at?: string | null;
}): string | null {
  if (upper(row.type) === LEDGER_TYPE_TRIP_EARNING_NET) {
    return row.economic_earned_at ?? null;
  }
  return row.economic_earned_at ?? row.posting_created_at ?? row.created_at ?? null;
}

export function mergeBackendEconomicFields<T extends { id?: string | null }>(
  row: T,
  fields: BackendEconomicFields | undefined,
): T & BackendEconomicFields {
  if (!fields) {
    return {
      ...row,
      posting_created_at: (row as { created_at?: string | null }).created_at ?? null,
      economic_earned_at: null,
      economic_date_status: null,
    };
  }
  const capturedSafe = fields.economic_date_status === ECONOMIC_DATE_STATUS.RESOLVED
    ? fields.captured_at ?? null
    : null;
  return {
    ...row,
    posting_created_at: fields.posting_created_at ?? null,
    economic_earned_at: fields.economic_earned_at ?? null,
    economic_date_status: fields.economic_date_status ?? null,
    captured_at: capturedSafe,
    eligible_at: fields.eligible_at ?? null,
    clearing_status: fields.clearing_status ?? null,
  };
}

export function parseOwnWalletEarningRow(raw: Record<string, unknown>): BackendEconomicFields {
  const status = typeof raw.economic_date_status === "string" ? raw.economic_date_status : null;
  const resolved = status === ECONOMIC_DATE_STATUS.RESOLVED;
  return {
    ledger_entry_id: typeof raw.ledger_entry_id === "string" ? raw.ledger_entry_id : null,
    related_trip_id: typeof raw.related_trip_id === "string" ? raw.related_trip_id : null,
    amount_pence: typeof raw.amount_pence === "number" ? raw.amount_pence : Number(raw.amount_pence ?? 0),
    type: typeof raw.type === "string" ? raw.type : null,
    description: typeof raw.description === "string" ? raw.description : null,
    posting_created_at: typeof raw.posting_created_at === "string" ? raw.posting_created_at : null,
    economic_earned_at: typeof raw.economic_earned_at === "string" ? raw.economic_earned_at : null,
    economic_date_status: status,
    captured_at: resolved && typeof raw.captured_at === "string" ? raw.captured_at : null,
    eligible_at: typeof raw.eligible_at === "string" ? raw.eligible_at : null,
    clearing_status: typeof raw.clearing_status === "string" ? raw.clearing_status : null,
  };
}

export function sumAttributedTripEarningNetPence<
  T extends {
    type?: string | null;
    amount_pence?: number | null;
    economic_earned_at?: string | null;
  },
>(
  rows: T[],
  startIso: string,
  endIso: string,
): number {
  let sum = 0;
  for (const row of rows) {
    if (upper(row.type) !== LEDGER_TYPE_TRIP_EARNING_NET) continue;
    if (!isInstantInHalfOpenRange(row.economic_earned_at, startIso, endIso)) continue;
    const amount = Number(row.amount_pence ?? 0);
    if (!Number.isFinite(amount)) continue;
    sum += Math.round(amount);
  }
  return sum;
}
