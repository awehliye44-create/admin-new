import { format, subDays, startOfQuarter, endOfQuarter } from 'date-fns';
import {
  FINANCE_LONDON_TZ,
  getLondonDayBounds,
  getLondonWeekStart,
  getLondonMonthStart,
} from '@/lib/financeLondonDay';

export type FinancePeriod =
  | 'today'
  | 'yesterday'
  | 'week'
  | 'last_week'
  | 'month'
  | 'last_month'
  | 'quarter'
  | 'year'
  | 'custom';

export type FinancePeriodBounds = {
  from: string;
  to: string;
  label: string;
  period: FinancePeriod;
};

function getLondonYearStart(date: Date = new Date()): Date {
  const { y } = getLondonCalendarPartsSafe(date);
  const probe = new Date(Date.UTC(y, 0, 1, 12, 0, 0));
  const londonHour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: FINANCE_LONDON_TZ, hour: 'numeric', hour12: false }).format(probe),
  );
  const offsetMs = (londonHour - 12) * 60 * 60 * 1000;
  return new Date(Date.UTC(y, 0, 1, 0, 0, 0) - offsetMs);
}

function getLondonCalendarPartsSafe(date: Date): { y: number; m: number; d: number } {
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

export function resolveFinancePeriodBounds(
  period: FinancePeriod,
  customFrom?: Date,
  customTo?: Date,
  now: Date = new Date(),
): FinancePeriodBounds {
  if (period === 'today') {
    const { start, end } = getLondonDayBounds(now);
    return {
      period,
      from: start.toISOString(),
      to: end.toISOString(),
      label: formatLondonDateLabel(start, end, 'Today'),
    };
  }

  if (period === 'yesterday') {
    const yday = subDays(now, 1);
    const { start, end } = getLondonDayBounds(yday);
    return {
      period,
      from: start.toISOString(),
      to: end.toISOString(),
      label: formatLondonDateLabel(start, end, 'Yesterday'),
    };
  }

  if (period === 'week') {
    const { end } = getLondonDayBounds(now);
    const start = getLondonWeekStart(now);
    return {
      period,
      from: start.toISOString(),
      to: end.toISOString(),
      label: formatLondonDateLabel(start, end, 'This week'),
    };
  }

  if (period === 'last_week') {
    const thisWeekStart = getLondonWeekStart(now);
    const lastWeekEnd = new Date(thisWeekStart.getTime() - 1);
    const lastWeekStart = getLondonWeekStart(lastWeekEnd);
    return {
      period,
      from: lastWeekStart.toISOString(),
      to: lastWeekEnd.toISOString(),
      label: formatLondonDateLabel(lastWeekStart, lastWeekEnd, 'Last week'),
    };
  }

  if (period === 'month') {
    const { end } = getLondonDayBounds(now);
    const start = getLondonMonthStart(now);
    return {
      period,
      from: start.toISOString(),
      to: end.toISOString(),
      label: formatLondonDateLabel(start, end, 'This month'),
    };
  }

  if (period === 'last_month') {
    const thisMonthStart = getLondonMonthStart(now);
    const lastMonthEnd = new Date(thisMonthStart.getTime() - 1);
    const lastMonthStart = getLondonMonthStart(lastMonthEnd);
    return {
      period,
      from: lastMonthStart.toISOString(),
      to: lastMonthEnd.toISOString(),
      label: formatLondonDateLabel(lastMonthStart, lastMonthEnd, 'Last month'),
    };
  }

  if (period === 'quarter') {
    const start = startOfQuarter(now);
    const end = endOfQuarter(now);
    const { start: qStart } = getLondonDayBounds(start);
    const { end: qEnd } = getLondonDayBounds(end > now ? now : end);
    return {
      period,
      from: qStart.toISOString(),
      to: qEnd.toISOString(),
      label: formatLondonDateLabel(qStart, qEnd, 'Quarter'),
    };
  }

  if (period === 'year') {
    const { end } = getLondonDayBounds(now);
    const start = getLondonYearStart(now);
    return {
      period,
      from: start.toISOString(),
      to: end.toISOString(),
      label: formatLondonDateLabel(start, end, 'This year'),
    };
  }

  const fromDate = customFrom ?? now;
  const { start } = getLondonDayBounds(fromDate);
  const { end } = getLondonDayBounds(customTo ?? fromDate);
  return {
    period,
    from: start.toISOString(),
    to: end.toISOString(),
    label: formatLondonDateLabel(start, end, 'Custom'),
  };
}

function formatLondonDateLabel(from: Date, to: Date, prefix: string): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: FINANCE_LONDON_TZ,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const fromStr = fmt.format(from);
  const toStr = fmt.format(to);
  if (fromStr === toStr) return `${prefix} (${fromStr}, London)`;
  return `${prefix} (${fromStr} – ${toStr}, London)`;
}

/** Activity timestamp falls within [from, to] (ISO strings, inclusive). */
export function isTimestampInPeriod(
  value: string | null | undefined,
  from: string,
  to: string,
): boolean {
  if (!value) return false;
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return false;
  return t >= new Date(from).getTime() && t <= new Date(to).getTime();
}

/** Pick best activity timestamp for payout/batch rows. */
export function payoutActivityTimestamp(row: {
  completed_at?: string | null;
  completedAt?: string | null;
  failed_at?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
  runDate?: string | null;
  paid_at?: string | null;
  paidAt?: string | null;
  status?: string | null;
}): string | null {
  return (
    row.completed_at
    ?? row.completedAt
    ?? row.paid_at
    ?? row.paidAt
    ?? row.failed_at
    ?? row.runDate
    ?? row.created_at
    ?? row.createdAt
    ?? null
  );
}

export function formatFinancePeriodInputDate(value: Date | undefined): string {
  if (!value) return '';
  try {
    return format(value, 'yyyy-MM-dd');
  } catch {
    return '';
  }
}
