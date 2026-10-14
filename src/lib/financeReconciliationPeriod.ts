import { getLondonDayBounds } from '@/lib/financeLondonDay';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function londonDayBoundsFor(value: string): { start: Date; end: Date } {
  const [y, m, d] = value.split('-').map(Number);
  return getLondonDayBounds(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)));
}

/**
 * Normalize admin date inputs (`YYYY-MM-DD`) to Europe/London full-day ISO bounds —
 * the same UK calendar day the backend, Drivers tab and payout periods use.
 */
export function normalizeFinanceReconciliationPeriod(
  from?: string,
  to?: string,
): { from?: string; to?: string } {
  const normalizeStart = (value: string) =>
    DATE_ONLY.test(value) ? londonDayBoundsFor(value).start.toISOString() : value;
  const normalizeEnd = (value: string) =>
    DATE_ONLY.test(value) ? londonDayBoundsFor(value).end.toISOString() : value;
  return {
    from: from?.trim() ? normalizeStart(from.trim()) : undefined,
    to: to?.trim() ? normalizeEnd(to.trim()) : undefined,
  };
}
