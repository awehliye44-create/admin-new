/**
 * @vitest-environment node
 *
 * Lock: Phase A8B13C force_driver_offline writes valid presence app_state.
 * Option A: background (lifecycle), not terminated. Constraint unchanged.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const SQL =
  'supabase/migrations/20261109280000_phase_a8b13c_force_driver_offline_presence_state_fix.sql';
const RB =
  'supabase/migrations/rollback/rollback_20261109280000_phase_a8b13c_force_driver_offline_presence_state_fix.sql';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phaseA8B13CForceDriverOfflinePresenceStateFix', () => {
  it('replaces terminated with background; preserves A8B13A gate and ACL', () => {
    const sql = read(SQL);
    const rb = read(RB);

    expect(sql).toMatch(/Canonical version: 20261109280000/i);
    expect(sql).not.toMatch(/NOT APPLIED/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.force_driver_offline/);
    expect(sql).toMatch(/auth\.role\(\) IS DISTINCT FROM 'service_role'/);
    expect(sql).toMatch(/auth\.uid\(\) IS DISTINCT FROM v_driver\.user_id/);
    expect(sql).toMatch(/RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'/);
    expect(sql).toMatch(/false, 'background', now\(\)/);
    expect(sql).toMatch(/app_state = 'background'/);
    const body = sql.slice(sql.indexOf('AS $fn$'), sql.indexOf('$fn$;'));
    expect(body).not.toMatch(/'terminated'/);
    expect(body).not.toMatch(/EXISTS[\s\S]{0,80}profiles\.role/);
    expect(sql).not.toMatch(/ALTER TABLE[\s\S]{0,80}driver_presence/i);
    expect(sql).not.toMatch(/DROP CONSTRAINT.*driver_presence_app_state_check/i);
    expect(sql).toMatch(/03fbd3a02fab2fe38af849d4eb8c5f6d/);
    expect(sql).toMatch(/0083223b11219bfa908030434d8c8500/);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.force_driver_offline\(uuid, text\) TO authenticated/i,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.force_driver_offline\(uuid, text\) TO service_role/i,
    );
    expect(sql).not.toMatch(/GRANT EXECUTE.*TO (PUBLIC|anon)/i);

    expect(rb).toMatch(/'terminated'/);
    expect(rb).toMatch(/COALESCE\(NULLIF\(public\.driver_presence\.app_state, ''\), 'terminated'\)/);
    expect(rb).toMatch(/A8B13A/);
  });
});
