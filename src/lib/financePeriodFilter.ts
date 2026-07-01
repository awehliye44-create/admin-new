import { format } from 'date-fns';
import {
  FINANCE_LONDON_TZ,
  getLondonDayBounds,
  getLondonWeekStart,
} from '@/lib/financeLondonDay';

export type FinancePeriod = 'today' | 'week' | 'custom';

export type FinancePeriodBounds = {
  from: string;
  to: string;
  label: string;
  period: FinancePeriod;
};

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
