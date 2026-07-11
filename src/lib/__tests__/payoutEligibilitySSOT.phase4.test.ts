import { describe, expect, it } from 'vitest';
import { sumClearedSettlementBatchPence } from '../../../supabase/functions/_shared/payoutEligibilitySSOT.ts';

describe('sumClearedSettlementBatchPence', () => {
  it('includes only settled payable card earnings', () => {
    const total = sumClearedSettlementBatchPence([
      {
        amount_pence: 500,
        payment_method: 'card',
        settlement_status: 'settled',
        trip_completed: true,
        payment_captured: true,
        captured_amount_pence: 500,
        capture_mismatch_unresolved: false,
      },
      {
        amount_pence: 300,
        payment_method: 'card',
        settlement_status: 'pending',
        trip_completed: true,
        payment_captured: true,
        captured_amount_pence: 300,
        capture_mismatch_unresolved: false,
      },
      {
        amount_pence: 200,
        payment_method: 'cash',
        trip_completed: true,
        payment_captured: true,
      },
    ]);
    expect(total).toBe(700);
  });
});
