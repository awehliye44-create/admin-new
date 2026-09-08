/**
 * Lock: Phase A2 reactivate_corporate_account body gate.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261107225000_phase_a2_reactivate_corporate_account_authz_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261107225000_phase_a2_reactivate_corporate_account_authz_lock.sql';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phaseA2ReactivateCorporateAccountAuthzLock', () => {
  it('gates corporate-accounts and keeps authenticated EXECUTE plus reactivation logic', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).toMatch(/staff_has_page_access\('corporate-accounts'\)/);
    expect(sql).toMatch(/auth\.role\(\) IS DISTINCT FROM 'service_role'/);
    expect(sql).toMatch(/SET status = 'active'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'Account not found'/);
    expect(sql).not.toMatch(/REVOKE ALL ON FUNCTION public\.reactivate_corporate_account/);
    expect(sql).not.toMatch(/suspend_corporate_account/);
    expect(rb).toMatch(/CREATE OR REPLACE FUNCTION public\.reactivate_corporate_account/);
    expect(rb).not.toMatch(/staff_has_page_access/);
    expect(rb).toMatch(/GRANT EXECUTE ON FUNCTION public\.reactivate_corporate_account\(uuid\) TO authenticated/i);
    expect(rb).toMatch(/GRANT EXECUTE ON FUNCTION public\.reactivate_corporate_account\(uuid\) TO service_role/i);
    expect(rb).not.toMatch(/UPDATE public\.corporate_accounts/i);
  });
});
