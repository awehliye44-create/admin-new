/**
 * Lock: Phase A8B25 active_super_admin_count body authorization draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109390000_phase_a8b25_active_super_admin_count_authz_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109390000_phase_a8b25_active_super_admin_count_authz_lock.sql';
const VERIFY =
  'supabase/tests/phase_a8b25_active_super_admin_count_authz_verify.sql';

const BASELINE = '58e091581d9ff11025e36901903d4eb7';
const PROPOSED = '4881dff6064dfe3abbc777e36d02d78f';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phaseA8B25ActiveSuperAdminCountAuthzLock', () => {
  it('gates the count to admin/staff actors and revokes unused service_role', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    const verify = read(VERIFY);

    expect(sql).toMatch(/Applied to ACTIVE_HEALTHY/i);
    expect(sql).toMatch(/active_super_admin_count/);
    expect(sql).toMatch(/has_role\(auth\.uid\(\), 'admin'/);
    expect(sql).toMatch(/is_super_admin\(auth\.uid\(\)\)/);
    expect(sql).toMatch(/staff_profiles sp/);
    expect(sql).toMatch(/ERRCODE = '42501'/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.active_super_admin_count\(\) FROM service_role/i);
    expect(sql).not.toMatch(/current_user/);
    expect(sql).not.toMatch(/raw_user_meta_data/);
    expect(sql).not.toMatch(/profiles\.role/);
    expect(sql).not.toMatch(/GRANT EXECUTE.*TO (PUBLIC|anon)/i);
    expect(sql).toContain(BASELINE);
    expect(sql).toContain(PROPOSED);

    expect(rb).toContain(BASELINE);
    expect(rb).toMatch(/GRANT EXECUTE ON FUNCTION public\.active_super_admin_count\(\) TO service_role/i);
    expect(rb).not.toMatch(/GRANT EXECUTE.*TO (PUBLIC|anon)/i);

    expect(verify).toMatch(/A8B25_SIM_OK/);
    expect(verify).toContain(PROPOSED);
    expect(verify).toContain(BASELINE);
  });
});
