/**
 * Lock: Phase A8B22 can_driver_edit_vehicle self-bind.
 * If this fails, fix the migration — never delete or soften the lock.
 *
 * Hash convention: proposed/baseline body MD5 = md5(pg_proc.prosrc).
 * md5(pg_get_functiondef) for the same proposed body is FUNCTIONDEF_MD5
 * (CREATE header; default VOLATILE omitted by Postgres).
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
const FUNCTIONDEF_MD5 = '6a697ff69ec0513c7bd66c90f2664623';
const PARENT_PROSRC_MD5 = 'f75402c7ca6e1af186cc4656de927f2a';
const PARENT_FUNCTIONDEF_MD5 = '6537e6b1ae01c9dc2c843b08d5b2556f';

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
    expect(sql).toMatch(/has_role\(auth\.uid\(\),'admin'\) bypasses BEFORE the child call/);
    expect(sql).toMatch(/Null auth\.uid\(\) is NOT the normal Driver\/Admin trigger path/);
    expect(sql).toMatch(/md5\(pg_proc\.prosrc\)/);
    expect(sql).toContain(FUNCTIONDEF_MD5);
    expect(sql).toContain(PARENT_PROSRC_MD5);
    expect(sql).toContain(PARENT_FUNCTIONDEF_MD5);
    // Forbid bypass patterns in the CREATE body (header may name them as excluded).
    const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.can_driver_edit_vehicle'));
    expect(body).not.toMatch(/current_user/);
    expect(body).not.toMatch(/profiles\.role/);
    expect(body).not.toMatch(/raw_user_meta_data/);
    expect(body).not.toMatch(/auth\.role\(\)\s*=\s*'service_role'/);
    expect(sql).not.toMatch(/current_user\s*=\s*'postgres'/);
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
    expect(verify).toContain(PARENT_PROSRC_MD5);
    expect(verify).toMatch(/NOT the normal Driver\/Admin vehicles-trigger/);
  });
});
