/** Admin presentation-only helpers; not part of Edge uploads. */
import { parseExpiryCalendarDate, isDocumentExpiredLondon, getLondonCalendarDate, londonDateToUtcMs } from "../../supabase/functions/_shared/documentExpiryLondon.ts";


export function isDocumentExpiringSoonLondon(
  expiryDate: string | null | undefined,
  warningDays: number,
  now: Date = new Date(),
): boolean {
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
