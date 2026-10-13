import { describe, expect, it } from 'vitest';
import { normalizeFinanceReconciliationPeriod } from '@/lib/financeReconciliationPeriod';
import { normalizeFinancePeriodParam } from '../../../supabase/functions/_shared/financeLondonDay';

describe('normalizeFinanceReconciliationPeriod', () => {
  it('expands a summer (BST) date to the UK calendar day', () => {
    expect(normalizeFinanceReconciliationPeriod('2026-07-04', '2026-07-04')).toEqual({
      from: '2026-07-03T23:00:00.000Z',
      to: '2026-07-04T22:59:59.999Z',
    });
  });

  it('expands a winter (GMT) date to the UK calendar day', () => {
    expect(normalizeFinanceReconciliationPeriod('2026-12-01', '2026-12-31')).toEqual({
      from: '2026-12-01T00:00:00.000Z',
      to: '2026-12-31T23:59:59.999Z',
    });
  });

  it('matches the backend UK-day normaliser exactly', () => {
    for (const day of ['2026-01-15', '2026-03-29', '2026-06-30', '2026-10-25', '2026-10-26']) {
      const period = normalizeFinanceReconciliationPeriod(day, day);
      expect(period.from).toBe(normalizeFinancePeriodParam(day, 'start'));
      expect(period.to).toBe(normalizeFinancePeriodParam(day, 'end'));
    }
  });

  it('passes through full ISO timestamps', () => {
    const from = '2026-07-04T08:00:00.000Z';
    const to = '2026-07-04T18:00:00.000Z';
    expect(normalizeFinanceReconciliationPeriod(from, to)).toEqual({ from, to });
  });
});
