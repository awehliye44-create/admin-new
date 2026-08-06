/**
 * Deterministic driver earnings reporting periods.
 * Convention: period_start inclusive, period_end_exclusive exclusive.
 * Next period starts exactly at period_end_exclusive.
 */

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function toIsoDateUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Add calendar months in UTC (day clamped to last day of target month). */
export function addUtcMonths(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(y, m, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay)));
}

export type NMonthPeriod = {
  periodStartInclusive: string;
  periodEndExclusive: string;
  /** Legacy inclusive date for columns that store end-of-day inclusive. */
  periodEndInclusive: string;
  nextPeriodStartInclusive: string;
};

/**
 * Build a non-overlapping N-month window ending at `asOf` (exclusive end = asOf date UTC).
 * Example: asOf=2026-08-06, interval=8 → start=2025-12-06, endExclusive=2026-08-06.
 */
export function resolveEveryNMonthsPeriod(
  asOf: Date,
  intervalMonths: number,
): NMonthPeriod {
  const months = Math.min(36, Math.max(1, Math.round(intervalMonths)));
  const endExclusive = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const startInclusive = addUtcMonths(endExclusive, -months);
  const endInclusiveDate = new Date(endExclusive.getTime() - 86400000);
  return {
    periodStartInclusive: toIsoDateUTC(startInclusive),
    periodEndExclusive: toIsoDateUTC(endExclusive),
    periodEndInclusive: toIsoDateUTC(endInclusiveDate),
    nextPeriodStartInclusive: toIsoDateUTC(endExclusive),
  };
}

/** Consecutive periods must abut: a.endExclusive === b.startInclusive */
export function periodsAbut(a: NMonthPeriod, b: NMonthPeriod): boolean {
  return a.periodEndExclusive === b.periodStartInclusive;
}

export function computeNextRunAtUtc(
  from: Date,
  intervalMonths: number,
  generationDay: number,
  sendHour: number,
): Date {
  const months = Math.min(36, Math.max(1, Math.round(intervalMonths)));
  const base = addUtcMonths(from, months);
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = generationDay <= 0 ? lastDay : Math.min(generationDay, lastDay);
  return new Date(Date.UTC(y, m, day, Math.min(23, Math.max(0, sendHour)), 0, 0));
}
