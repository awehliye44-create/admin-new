/**
 * Admin Payment Sessions list select lock — airport must be fetched for tip/airport display.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  resolve(__dirname, '../../../supabase/functions/_shared/adminPaymentSessionsListSSOT.ts'),
  'utf8',
);

describe('adminPaymentSessionsListSSOT tip/airport select lock', () => {
  it('selects airport_charge_pence with tip stamps (NO_MIGRATION_REQUIRED)', () => {
    expect(SOURCE).toMatch(/tip_pence,\s*tip_amount_pence,\s*airport_charge_pence/);
    expect(SOURCE).toMatch(/row\.tip_pence\s*=/);
    expect(SOURCE).toMatch(/row\.airport_charge_pence\s*=/);
  });
});
