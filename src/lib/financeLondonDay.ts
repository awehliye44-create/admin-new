/** Europe/London calendar day bounds — matches payout diagnostics and Provider “today” cards. */
export const FINANCE_LONDON_TZ = 'Europe/London';

export function getLondonCalendarParts(date: Date = new Date()): { y: number; m: number; d: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: FINANCE_LONDON_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  return {
    y: Number(parts.find((p) => p.type === 'year')?.value ?? '1970'),
    m: Number(parts.find((p) => p.type === 'month')?.value ?? '1'),
    d: Number(parts.find((p) => p.type === 'day')?.value ?? '1'),
  };
}

/** UTC instants for start/end of a calendar day in London (inclusive end). */
export function getLondonDayBounds(date: Date = new Date()): { start: Date; end: Date } {
  const { y, m, d } = getLondonCalendarParts(date);
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const offsetMs = getLondonOffsetMs(probe);
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}

function getLondonOffsetMs(utcNoon: Date): number {
  const londonHour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: FINANCE_LONDON_TZ, hour: 'numeric', hour12: false }).format(
      utcNoon,
    ),
  );
  return (londonHour - 12) * 60 * 60 * 1000;
}

/** Start of current London week (Monday 00:00). */
export function getLondonWeekStart(date: Date = new Date()): Date {
  const { start: todayStart } = getLondonDayBounds(date);
  const londonWeekday = new Intl.DateTimeFormat('en-GB', {
    timeZone: FINANCE_LONDON_TZ,
    weekday: 'short',
  }).format(date);
  const dayIndex = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(londonWeekday);
  const offsetDays = dayIndex >= 0 ? dayIndex : 0;
  return new Date(todayStart.getTime() - offsetDays * 24 * 60 * 60 * 1000);
}

/** Start of current London calendar month. */
export function getLondonMonthStart(date: Date = new Date()): Date {
  const { y, m } = getLondonCalendarParts(date);
  const probe = new Date(Date.UTC(y, m - 1, 1, 12, 0, 0));
  const offsetMs = getLondonOffsetMs(probe);
  return new Date(Date.UTC(y, m - 1, 1, 0, 0, 0) - offsetMs);
}
