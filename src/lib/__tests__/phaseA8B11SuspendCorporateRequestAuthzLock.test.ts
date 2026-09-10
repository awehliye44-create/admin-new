/**
 * Lock: Phase A8B11 suspend_corporate_request body gate + actor binding.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109230000_phase_a8b11_suspend_corporate_request_authz_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109230000_phase_a8b11_suspend_corporate_request_authz_lock.sql';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phaseA8B11SuspendCorporateRequestAuthzLock', () => {
  it('gates account-requests, stamps auth.uid for staff, keeps authenticated EXECUTE', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);

    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).toMatch(/staff_has_page_access\('account-requests'\)/);
    expect(sql).toMatch(/auth\.role\(\) IS DISTINCT FROM 'service_role'/);
    expect(sql).toMatch(/WHEN auth\.role\(\) = 'service_role' THEN COALESCE\(p_reviewed_by, auth\.uid\(\)\)/);
    expect(sql).toMatch(/ELSE auth\.uid\(\)/);
    expect(sql).toMatch(/SET status = 'suspended'/);
    expect(sql).toMatch(/reviewed_by = v_reviewer/);
    expect(sql).toMatch(/RAISE EXCEPTION 'Request not found'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'/);
    expect(sql).not.toMatch(/current_user\s*=\s*'postgres'/);
    expect(sql).not.toMatch(/REVOKE ALL ON FUNCTION public\.suspend_corporate_request/);
    expect(sql).not.toMatch(/suspend_corporate_account/);
    expect(sql).not.toMatch(/INSERT INTO public\.corporate_audit_log/i);
    expect(sql).not.toMatch(/log_corporate_audit/i);

    expect(rb).toMatch(/CREATE OR REPLACE FUNCTION public\.suspend_corporate_request/);
    expect(rb).toMatch(/reviewed_by = p_reviewed_by/);
    expect(rb).not.toMatch(/staff_has_page_access/);
    expect(rb).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.suspend_corporate_request\(uuid, uuid\) TO authenticated/i,
    );
    expect(rb).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.suspend_corporate_request\(uuid, uuid\) TO service_role/i,
    );
    expect(rb).not.toMatch(/GRANT EXECUTE.*TO (PUBLIC|anon)/i);
    expect(rb).not.toMatch(/UPDATE public\.corporate_account_requests/i);
  });
});
