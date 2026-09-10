/**
 * Lock: Phase A8B20 is_admin body authorization draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109350000_phase_a8b20_is_admin_authz_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109350000_phase_a8b20_is_admin_authz_lock.sql';
const VERIFY = 'supabase/tests/phase_a8b20_is_admin_authz_lock_verify.sql';

const BASELINE_MD5 = '31925d8b75f95e780ed00846e788c399';
const PROPOSED_MD5 = '63fcc2103c85dd3aeb1796bee8d8720e';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phaseA8B20IsAdminAuthzLock', () => {
  it('replaces metadata body with has_role(auth.uid(), admin) and restores baseline', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    const verify = read(VERIFY);

    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.is_admin\(\)/);
    expect(sql).toMatch(/has_role\(auth\.uid\(\),\s*'admin'::public\.app_role\)/);
    expect(sql).not.toMatch(/raw_user_meta_data/);
    expect(sql).not.toMatch(/raw_app_meta_data/);
    expect(sql).not.toMatch(/user_metadata/);
    expect(sql).not.toMatch(/profiles\.role/);
    expect(sql).not.toMatch(/current_user\s*=\s*'postgres'/);
    expect(sql).not.toMatch(/REVOKE ALL ON FUNCTION public\.is_admin/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.is_admin\(\) TO authenticated/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.is_admin\(\) TO service_role/i);
    expect(sql).not.toMatch(/GRANT EXECUTE.*TO (PUBLIC|anon)/i);
    expect(sql).toContain(BASELINE_MD5);
    expect(sql).toContain(PROPOSED_MD5);
    expect(sql).toMatch(/admin_driver_wallet_eligibility_balances/);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.admin_driver_wallet_eligibility_balances/i);

    expect(rb).toMatch(/raw_user_meta_data->>'role' = 'admin'/);
    expect(rb).toMatch(/GRANT EXECUTE ON FUNCTION public\.is_admin\(\) TO authenticated/i);
    expect(rb).toMatch(/GRANT EXECUTE ON FUNCTION public\.is_admin\(\) TO service_role/i);
    expect(rb).not.toMatch(/GRANT EXECUTE.*TO (PUBLIC|anon)/i);
    expect(rb).toContain(BASELINE_MD5);

    expect(verify).toMatch(/A8B20_SIM_OK/);
    expect(verify).toMatch(/63fcc2103c85dd3aeb1796bee8d8720e/);
    expect(verify).toMatch(/31925d8b75f95e780ed00846e788c399/);
  });
});
