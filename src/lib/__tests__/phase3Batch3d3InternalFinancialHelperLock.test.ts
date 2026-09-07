/**
 * Lock: Phase 3 Batch 3D3 internal financial helper EXECUTE lock.
 * If this fails, fix the migration — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261107213000_phase3_batch3d3_internal_financial_helper_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261107213000_phase3_batch3d3_internal_financial_helper_lock.sql';

const REVOKED = [
  'recalculate_driver_wallet(uuid)',
  'refresh_driver_wallet_reservation_cache(uuid)',
  'ensure_driver_commission_wallet_account(uuid, uuid, text)',
  'next_trip_invoice_number()',
  'release_invoice_smoke_send_slot(text)',
  'driver_wallet_payout_clearing_delay_hours()',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phase3Batch3d3InternalFinancialHelperLock', () => {
  it('revokes internal helpers without touching bodies or postgres', () => {
    const sql = read(CANONICAL);
    expect(REVOKED).toHaveLength(6);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    for (const sig of REVOKED) {
      const s = `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM authenticated`, 'i'));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'));
    }
    expect(read(ROLLBACK)).not.toMatch(/\bREVOKE\b/i);
  });
});
