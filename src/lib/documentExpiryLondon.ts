/** Canonical ONECAB driver document expiry — calendar dates in Europe/London. */
export const DRIVER_DOCUMENT_EXPIRY_TZ = "Europe/London";

/**
 * Policy (P0 document expiry SSOT):
 * - expiry_date is valid for the entire calendar day in Europe/London.
 * - Expired when expiry_date < today (London).
 * - expiry_date === today → still valid until 23:59:59 London.
 */
export function getLondonCalendarDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DRIVER_DOCUMENT_EXPIRY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Parse YYYY-MM-DD (date column) without UTC midnight drift. */
export function parseExpiryCalendarDate(expiryDate: string): string | null {
  const trimmed = expiryDate.trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  return match ? match[1] : null;
}

export function isDocumentExpiredLondon(
  expiryDate: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!expiryDate) return false;
  const expiryDay = parseExpiryCalendarDate(expiryDate);
  if (!expiryDay) return false;
  const todayLondon = getLondonCalendarDate(now);
  return expiryDay < todayLondon;
}

export function isDocumentExpiringSoonLondon(
  expiryDate: string | null | undefined,
  warningDays: number,
  now: Date = new Date(),
): boolean {
  if (!expiryDate || warningDays <= 0) return false;
  const expiryDay = parseExpiryCalendarDate(expiryDate);
  if (!expiryDay) return false;
  if (isDocumentExpiredLondon(expiryDate, now)) return false;

  const daysLeft = getDaysUntilExpiryLondon(expiryDate, now);
  return daysLeft != null && daysLeft >= 0 && daysLeft <= warningDays;
}

export function getDaysUntilExpiryLondon(
  expiryDate: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!expiryDate) return null;
  const expiryDay = parseExpiryCalendarDate(expiryDate);
  if (!expiryDay) return null;

  const todayLondon = getLondonCalendarDate(now);
  const todayMs = londonDateToUtcMs(todayLondon);
  const expiryMs = londonDateToUtcMs(expiryDay);
  if (todayMs == null || expiryMs == null) return null;

  return Math.round((expiryMs - todayMs) / 86_400_000);
}

function londonDateToUtcMs(yyyyMmDd: string): number | null {
  const parts = yyyyMmDd.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [y, m, d] = parts;
  const utcGuess = Date.UTC(y, m - 1, d, 12, 0, 0);
  const londonOnGuess = getLondonCalendarDate(new Date(utcGuess));
  if (londonOnGuess === yyyyMmDd) return utcGuess;

  const offsetDays = londonOnGuess < yyyyMmDd ? 1 : -1;
  return Date.UTC(y, m - 1, d + offsetDays, 12, 0, 0);
}
