import { endOfDay, startOfDay, startOfMonth, startOfWeek } from 'date-fns';

export type FinancePeriod = 'daily' | 'weekly' | 'monthly' | 'custom';

export function resolveFinancePeriodRange(
  period: FinancePeriod,
  customFrom?: Date,
  customTo?: Date,
): { startDate: Date; endDate: Date } {
  const now = new Date();
  if (period === 'custom' && customFrom) {
    return {
      startDate: startOfDay(customFrom),
      endDate: customTo ? endOfDay(customTo) : endOfDay(now),
    };
  }
  if (period === 'weekly') {
    return { startDate: startOfWeek(now, { weekStartsOn: 1 }), endDate: endOfDay(now) };
  }
  if (period === 'monthly') {
    return { startDate: startOfMonth(now), endDate: endOfDay(now) };
  }
  return { startDate: startOfDay(now), endDate: endOfDay(now) };
}

export function financePeriodLabel(period: FinancePeriod, start: Date, end: Date): string {
  if (period === 'daily') return 'Today';
  if (period === 'weekly') return 'This week (Mon–Sun)';
  if (period === 'monthly') return 'This month to date';
  return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}
