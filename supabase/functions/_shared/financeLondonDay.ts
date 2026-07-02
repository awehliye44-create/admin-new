/** Europe/London calendar day — shared with admin finance SSOT. */
export const FINANCE_LONDON_TZ = "Europe/London";

export function getLondonCalendarParts(date: Date = new Date()): { y: number; m: number; d: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: FINANCE_LONDON_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(date);
  return {
    y: Number(parts.find((p) => p.type === "year")?.value ?? "1970"),
    m: Number(parts.find((p) => p.type === "month")?.value ?? "1"),
    d: Number(parts.find((p) => p.type === "day")?.value ?? "1"),
  };
}

function getLondonOffsetMs(utcNoon: Date): number {
  const londonHour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: FINANCE_LONDON_TZ, hour: "numeric", hour12: false }).format(
      utcNoon,
    ),
  );
  return (londonHour - 12) * 60 * 60 * 1000;
}

export function getLondonDayBounds(date: Date = new Date()): { start: Date; end: Date } {
  const { y, m, d } = getLondonCalendarParts(date);
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const offsetMs = getLondonOffsetMs(probe);
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}

export function isLondonSameCalendarDay(iso: string | null | undefined, ref: Date = new Date()): boolean {
  if (!iso) return false;
  const trip = getLondonCalendarParts(new Date(iso));
  const today = getLondonCalendarParts(ref);
  return trip.y === today.y && trip.m === today.m && trip.d === today.d;
}
