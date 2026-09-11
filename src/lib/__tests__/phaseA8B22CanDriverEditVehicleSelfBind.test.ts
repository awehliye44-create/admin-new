/**
 * Lock: Phase A8B22 can_driver_edit_vehicle self-bind.
 * If this fails, fix the migration — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109370000_phase_a8b22_can_driver_edit_vehicle_self_bind.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109370000_phase_a8b22_can_driver_edit_vehicle_self_bind.sql';
const VERIFY =
  'supabase/tests/phase_a8b22_can_driver_edit_vehicle_self_bind_verify.sql';

const BASELINE_MD5 = '49ee9d3d28b6b13d4e341f108eba79e5';
const PROPOSED_MD5 = '25e0661516a3f94821b02a0fabe69cab';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phaseA8B22CanDriverEditVehicleSelfBind', () => {
  it('self-binds authenticated callers and restores the exact production body', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    const verify = read(VERIFY);

    expect(sql).toMatch(/Applied to ACTIVE_HEALTHY/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.can_driver_edit_vehicle\(p_driver_id uuid\)/);
    expect(sql).toMatch(/d\.user_id = auth\.uid\(\)/);
    expect(sql).toMatch(/ERRCODE = '42501'/);
    expect(sql).toMatch(/check_vehicle_edit_allowed/);
    expect(sql).toMatch(/Null auth\.uid\(\)/);
    expect(sql).not.toMatch(/current_user/);
    expect(sql).not.toMatch(/profiles\.role/);
    expect(sql).not.toMatch(/raw_user_meta_data/);
    expect(sql).not.toMatch(/auth\.role\(\)\s*=\s*'service_role'/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.can_driver_edit_vehicle\(uuid\) TO authenticated/i);
    expect(sql).not.toMatch(/GRANT EXECUTE.*TO (PUBLIC|anon)/i);
    expect(sql).toContain(BASELINE_MD5);
    expect(sql).toContain(PROPOSED_MD5);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.check_vehicle_edit_allowed/i);

    expect(rb).toMatch(/FROM drivers\n  WHERE id = p_driver_id;/);
    expect(rb).not.toMatch(/auth\.uid\(\)/);
    expect(rb).toContain(BASELINE_MD5);
    expect(rb).not.toMatch(/GRANT EXECUTE.*TO (PUBLIC|anon)/i);

    expect(verify).toMatch(/A8B22_SIM_OK/);
    expect(verify).toContain(PROPOSED_MD5);
    expect(verify).toContain(BASELINE_MD5);
  });
});
