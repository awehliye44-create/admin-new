/**
 * Today’s earnings SSOT (Driver + driver-earnings-summary).
 *
 * today_earnings_pence =
 *   sum of eligible earning ledger credits whose Today attribution instant
 *   falls within the Europe/London business-day window.
 *
 * Canonical attribution (explicit fallback — never silent rewrite):
 *   today_at = valid economic_earned_at ?? posting_created_at ?? created_at
 *
 * - Normal TEN with a valid economic_earned_at keeps the economic date.
 * - CAPTURE_RELEASED / unresolved TEN with null economic falls back to posting
 *   so posted fare-net / late-cancel fees appear immediately.
 * - DRIVER_TIP_CREDIT uses tip-effective (economic) when present, else posting.
 * - Clearing (27h) governs Pending/Available only — not Today.
 * - Withdrawals, reservations, payout fees, and DRIVER_COLLECTED stay excluded.
 */

import {
  isInstantInHalfOpenRange,
  londonCivilDateKey,
} from "./economicEarnedAtSSOT.ts";


export const TODAY_EARNINGS_INCLUDE_TYPES = [
  "TRIP_EARNING_NET",
  "DRIVER_TIP_CREDIT",
  "NO_SHOW_FEE",
] as const;

/** Signed settlement corrections — amount may be negative. */
export const TODAY_EARNINGS_SETTLEMENT_CORRECTION_TYPES = [
  "REFUND_DEBIT",
] as const;

/** Never Today earnings (money movement / isolation / unapproved promos). */
export const TODAY_EARNINGS_EXCLUDE_TYPES = [
  "EARLY_CASHOUT",
  "PAYOUT_RESERVATION_HOLD",
  "PAYOUT",
  "WEEKLY_PAYOUT",
  "PLATFORM_COMMISSION",
  "CASH_TRIP_EARNING",
  "BONUS",
  "BALANCE_TRANSFER",
  "DRIVER_COLLECTED",
] as const;

const INCLUDE = new Set<string>(TODAY_EARNINGS_INCLUDE_TYPES);
const SETTLEMENT = new Set<string>(TODAY_EARNINGS_SETTLEMENT_CORRECTION_TYPES);
const EXCLUDE = new Set<string>(TODAY_EARNINGS_EXCLUDE_TYPES);

function upper(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

function isValidAttributionIso(iso: string | null | undefined): iso is string {
  if (typeof iso !== "string") return false;
  const trimmed = iso.trim();
  if (!trimmed) return false;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms);
}

export type TodayEarningsLedgerRow = {
  type?: string | null;
  amount_pence?: number | null;
  created_at?: string | null;
  posting_created_at?: string | null;
  economic_earned_at?: string | null;
  economic_date_status?: string | null;
};

/**
 * Today attribution instant.
 * Prefer a valid economic_earned_at; otherwise fall back to posting/created.
 * Explicit fallback only — does not invent timestamps or hide missing credits.
 */
export function todayEarningsAttributionInstant(
  row: TodayEarningsLedgerRow,
): string | null {
  if (isValidAttributionIso(row.economic_earned_at)) {
    return row.economic_earned_at.trim();
  }
  if (isValidAttributionIso(row.posting_created_at)) {
    return row.posting_created_at.trim();
  }
  if (isValidAttributionIso(row.created_at)) {
    return row.created_at.trim();
  }
  return null;
}

/**
 * DRIVER_COLLECTED (and other non-platform models) resolve as
 * FINANCIAL_MODEL_MISMATCH — keep them out of Platform-Collected Today.
 */
export function isDriverCollectedIsolated(
  row: TodayEarningsLedgerRow,
): boolean {
  const status = upper(row.economic_date_status);
  const type = upper(row.type);
  return (
    status === "FINANCIAL_MODEL_MISMATCH" ||
    type === "CASH_TRIP_EARNING" ||
    type === "DRIVER_COLLECTED" ||
    type.includes("DRIVER_COLLECTED")
  );
}

export function isTodayEarningsEligibleRow(row: TodayEarningsLedgerRow): boolean {
  const type = upper(row.type);
  if (!type) return false;
  if (EXCLUDE.has(type)) return false;
  if (isDriverCollectedIsolated(row)) return false;
  if (INCLUDE.has(type)) return true;
  if (SETTLEMENT.has(type)) return true;
  return false;
}

export function todayEarningsAmountPence(row: TodayEarningsLedgerRow): number {
  const n = Number(row.amount_pence ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/**
 * Sum eligible credits whose Today attribution instant lies in [startIso, endIso).
 * Does not invent amounts — missing ledger rows stay missing.
 */
export function sumTodayEarningsPence(
  rows: TodayEarningsLedgerRow[],
  startIso: string,
  endIso: string,
): number {
  let sum = 0;
  for (const row of rows) {
    if (!isTodayEarningsEligibleRow(row)) continue;
    const instant = todayEarningsAttributionInstant(row);
    if (!isInstantInHalfOpenRange(instant, startIso, endIso)) continue;
    sum += todayEarningsAmountPence(row);
  }
  return sum;
}

/** London civil-day key for a ledger credit’s Today attribution instant. */
export function todayEarningsLondonDayKey(
  row: TodayEarningsLedgerRow,
): string | null {
  return londonCivilDateKey(todayEarningsAttributionInstant(row));
}
