/**
 * Lock: Phase 3 Batch 3B remaining critical admin/financial RPC authz.
 * If this fails, fix the migration — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261107190000_phase3_batch3b_admin_financial_rpc_authz_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261107190000_phase3_batch3b_admin_financial_rpc_authz_lock.sql';

const REVOKED: { name: string; args: string }[] = [
  { name: 'ops_repair_missing_driver_earning', args: 'uuid' },
  { name: 'ops_repair_missing_financials', args: 'uuid' },
  { name: 'finalize_driver_early_cashout_paid', args: 'uuid' },
  { name: 'record_cash_trip_completion', args: 'uuid, uuid, integer, integer, text' },
  { name: 'reserve_driver_commission_wallet', args: 'uuid, uuid' },
  { name: 'release_driver_commission_wallet', args: 'uuid, uuid, text' },
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function sig(fn: { name: string; args: string }): string {
  return `public.${fn.name}(${fn.args})`;
}

function lit(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('phase3Batch3bAdminFinancialRpcAuthzLock', () => {
  it('gates retained Admin RPCs with exact page permissions and own-user ownership', () => {
    const sql = read(CANONICAL);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).toMatch(/staff_has_page_access\('account-requests'\)/);
    expect(sql).toMatch(/staff_has_page_access\('manual-trip'\)/);
    expect(sql).toMatch(/p_user_id IS DISTINCT FROM auth\.uid\(\)/);
    expect(sql).toMatch(/p_reviewed_by uuid DEFAULT NULL::uuid/);
    expect(sql).toMatch(/reviewed_by = v_reviewer/);
    expect(sql).not.toMatch(/reviewed_by = p_reviewed_by/);
    expect(sql).not.toMatch(/staff_has_company_funds_read_access\('account-requests'\)/);
    expect(sql).not.toMatch(/staff_has_company_funds_read_access\('manual-trip'\)/);
    expect(sql).not.toMatch(/DROP FUNCTION/i);
    expect(sql).not.toMatch(/FINANCIAL_MODEL_VIOLATION/);
  });

  it('revokes PUBLIC, anon and authenticated on money and legacy cash signatures', () => {
    const sql = read(CANONICAL);
    for (const fn of REVOKED) {
      const s = lit(sig(fn));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM PUBLIC`, 'i'));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM anon`, 'i'));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM authenticated`, 'i'));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'));
      expect(sql).not.toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM service_role`, 'i'));
      expect(sql).not.toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM postgres`, 'i'));
    }
  });

  it('rollback restores unguarded bodies and authenticated EXECUTE only', () => {
    const rb = read(ROLLBACK);
    expect(rb).toMatch(/reviewed_by = p_reviewed_by/);
    expect(rb).not.toMatch(/staff_has_page_access/);
    expect(rb).toMatch(/DROP FUNCTION IF EXISTS public\.staff_has_page_access\(text\)/);
    for (const fn of REVOKED) {
      expect(rb).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION ${lit(sig(fn))} TO authenticated`, 'i'),
      );
    }
  });
});
