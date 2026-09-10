/**
 * Lock: Phase A8B21 log_corporate_audit body authorization draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109360000_phase_a8b21_log_corporate_audit_authz_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109360000_phase_a8b21_log_corporate_audit_authz_lock.sql';
const VERIFY = 'supabase/tests/phase_a8b21_log_corporate_audit_authz_lock_verify.sql';

const BASELINE_MD5 = '189b2b510f1aefb10b115aea3e6a3d0f';
const PROPOSED_MD5 = '9d2aaa16834baa880931cd49b43553de';
const SIG =
  'log_corporate_audit(uuid, text, text, text, text, text, jsonb)';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phaseA8B21LogCorporateAuditAuthzLock', () => {
  it('allowlists proven portal actions with matching corporate gates', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    const verify = read(VERIFY);

    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.log_corporate_audit/);
    expect(sql).toMatch(/can_write_corporate\(v_uid, p_corporate_account_id\)/);
    expect(sql).toMatch(/has_corporate_access\(v_uid, p_corporate_account_id\)/);
    expect(sql).toMatch(/Employee Added/);
    expect(sql).toMatch(/Employee Removed/);
    expect(sql).toMatch(/Location Added/);
    expect(sql).toMatch(/Support Ticket Created/);
    expect(sql).toMatch(/ERRCODE = '42501'/);
    expect(sql).toMatch(/octet_length\(p_metadata::text\) > 4096/);
    expect(sql).toMatch(/user_id, action, action_type/);
    expect(sql).toMatch(/v_uid uuid := auth\.uid\(\)/);
    expect(sql).not.toMatch(/current_user/);
    expect(sql).not.toMatch(/staff_has_page_access/);
    expect(sql).not.toMatch(/is_admin\(/);
    expect(sql).not.toMatch(/REVOKE ALL ON FUNCTION public\.log_corporate_audit/i);
    expect(sql).toMatch(
      new RegExp(
        `GRANT EXECUTE ON FUNCTION public\\.${SIG.replace(/[()]/g, '\\$&')} TO authenticated`,
        'i',
      ),
    );
    expect(sql).not.toMatch(/GRANT EXECUTE.*TO (PUBLIC|anon)/i);
    expect(sql).toContain(BASELINE_MD5);
    expect(sql).toContain(PROPOSED_MD5);
    expect(sql).toMatch(/useCorporate\.ts/);
    expect(sql).toMatch(/Residual integrity limitation/i);
    expect(sql).toMatch(/does NOT prove/i);
    expect(sql).toMatch(/post-delete Employee Removed/i);
    expect(sql).toMatch(/atomic mutation \+ audit/i);
    expect(sql).not.toMatch(/EXISTS\s*\(\s*SELECT[\s\S]*corporate_users/i);

    expect(rb).toMatch(/auth\.uid\(\), p_action, p_action_type/);
    expect(rb).not.toMatch(/can_write_corporate/);
    expect(rb).not.toMatch(/has_corporate_access/);
    expect(rb).toContain(BASELINE_MD5);
    expect(rb).not.toMatch(/GRANT EXECUTE.*TO (PUBLIC|anon)/i);

    expect(verify).toMatch(/A8B21_SIM_OK/);
    expect(verify).toContain(PROPOSED_MD5);
    expect(verify).toContain(BASELINE_MD5);
  });
});
