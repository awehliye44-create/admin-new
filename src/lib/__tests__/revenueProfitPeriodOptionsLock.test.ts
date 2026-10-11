import { describe, expect, it } from 'vitest';
import { REVENUE_PERIODS } from '@/components/finance/FinancePeriodFilter';

/** ONECAB Revenue & Profit Report keeps exactly five period options. */
describe('revenue profit report period options', () => {
  it('offers only Today, Weekly, Monthly, This year and Custom', () => {
    expect(REVENUE_PERIODS.map((p) => p.value)).toEqual(['today', 'week', 'month', 'year', 'custom']);
    expect(REVENUE_PERIODS.map((p) => p.label)).toEqual([
      'Today',
      'Weekly',
      'Monthly',
      'This year',
      'Custom',
    ]);
  });

  it('never offers yesterday, last week, last month, quarter, last year or lifetime', () => {
    const forbidden = ['yesterday', 'last_week', 'last_month', 'quarter', 'last_year', 'lifetime'];
    expect(REVENUE_PERIODS.map((p) => p.value).filter((v) => forbidden.includes(v))).toEqual([]);
  });
});
