/** Edge copy — keep in sync with `shared/documentExpiryLondon.ts`. */ export const DRIVER_DOCUMENT_EXPIRY_TZ = "Europe/London";
export function getLondonCalendarDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DRIVER_DOCUMENT_EXPIRY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}
export function parseExpiryCalendarDate(expiryDate) {
  const trimmed = expiryDate.trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  return match ? match[1] : null;
}
export function isDocumentExpiredLondon(expiryDate, now = new Date()) {
  if (!expiryDate) return false;
  const expiryDay = parseExpiryCalendarDate(expiryDate);
  if (!expiryDay) return false;
  const todayLondon = getLondonCalendarDate(now);
  return expiryDay < todayLondon;
}
export function isDocumentExpiringSoonLondon(expiryDate, warningDays, now = new Date()) {
  if (!expiryDate || warningDays <= 0) return false;
  const expiryDay = parseExpiryCalendarDate(expiryDate);
  if (!expiryDay) return false;
  if (isDocumentExpiredLondon(expiryDate, now)) return false;
  const todayLondon = getLondonCalendarDate(now);
  const todayMs = londonDateToUtcMs(todayLondon);
  const expiryMs = londonDateToUtcMs(expiryDay);
  if (todayMs == null || expiryMs == null) return false;
  const diffDays = Math.round((expiryMs - todayMs) / 86_400_000);
  return diffDays >= 0 && diffDays <= warningDays;
}
function londonDateToUtcMs(yyyyMmDd) {
  const parts = yyyyMmDd.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n)=>!Number.isFinite(n))) return null;
  const [y, m, d] = parts;
  const utcGuess = Date.UTC(y, m - 1, d, 12, 0, 0);
  const londonOnGuess = getLondonCalendarDate(new Date(utcGuess));
  if (londonOnGuess === yyyyMmDd) return utcGuess;
  const offsetDays = londonOnGuess < yyyyMmDd ? 1 : -1;
  return Date.UTC(y, m - 1, d + offsetDays, 12, 0, 0);
}
