/**
 * Trip History select lock — airport / tip / commission rate stamps must be fetched
 * for Admin tip/airport component display (NO_MIGRATION_REQUIRED).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  resolve(__dirname, '../tripHistoryQuery.ts'),
  'utf8',
);

describe('tripHistoryQuery select lock', () => {
  it('selects airport_charge_pence alongside tip stamps (no schema migration)', () => {
    expect(SOURCE).toMatch(/tip_pence,\s*tip_amount_pence,\s*airport_charge_pence/);
    expect(SOURCE).toMatch(/accepted_commission_percent/);
    expect(SOURCE).toMatch(/driver_tier_commission_percent/);
  });
});
