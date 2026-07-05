import { describe, expect, it } from 'vitest';
import { normalizeFinanceReconciliationPeriod } from '@/lib/financeReconciliationPeriod';

describe('normalizeFinanceReconciliationPeriod', () => {
  it('expands date-only inputs to full-day ISO bounds', () => {
    expect(normalizeFinanceReconciliationPeriod('2026-07-04', '2026-07-04')).toEqual({
      from: '2026-07-04T00:00:00.000Z',
      to: '2026-07-04T23:59:59.999Z',
    });
  });

  it('passes through full ISO timestamps', () => {
    const from = '2026-07-04T08:00:00.000Z';
    const to = '2026-07-04T18:00:00.000Z';
    expect(normalizeFinanceReconciliationPeriod(from, to)).toEqual({ from, to });
  });
});
