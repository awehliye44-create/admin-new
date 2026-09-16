/**
 * FR capture_breakdown must pass tip/airport through for Admin display.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  resolve(__dirname, '../../../supabase/functions/_shared/financeSettlementSummary.ts'),
  'utf8',
);

describe('financeSettlementSummary capture_breakdown tip/airport lock', () => {
  it('includes tip_pence and airport_charge_pence on FR capture_breakdown echo', () => {
    expect(SOURCE).toMatch(/airport_charge_pence:\s*psCaptureBreakdown\.airport_charge_pence/);
    expect(SOURCE).toMatch(/tip_pence:\s*psCaptureBreakdown\.tip_pence/);
    expect(SOURCE).toMatch(/expected_fare_net_pence/);
    expect(SOURCE).toMatch(/actual_tip_credit_pence/);
    expect(SOURCE).toMatch(/actual_trip_earning_net_pence/);
  });

  it('does not touch frDriverReconciliationSSOT formulas', () => {
    expect(SOURCE.includes('frDriverReconciliationSSOT')).toBe(false);
  });
});
