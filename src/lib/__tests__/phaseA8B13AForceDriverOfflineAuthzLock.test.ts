/**
 * Lock: Phase A8B13A force_driver_offline body gate (self | service_role).
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109250000_phase_a8b13a_force_driver_offline_authz_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109250000_phase_a8b13a_force_driver_offline_authz_lock.sql';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phaseA8B13AForceDriverOfflineAuthzLock', () => {
  it('removes profiles.role admin path, keeps self|service_role, 42501, ACL', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);

    expect(sql).toMatch(/Applied: canonical version 20261109250000/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.force_driver_offline/);
    expect(sql).toMatch(/auth\.role\(\) IS DISTINCT FROM 'service_role'/);
    expect(sql).toMatch(/auth\.uid\(\) IS DISTINCT FROM v_driver\.user_id/);
    expect(sql).toMatch(/RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'/);
    expect(sql).toMatch(/0083223b11219bfa908030434d8c8500/);
    expect(sql).toMatch(/c2a240bbda71c3e66f7ead124b736723/);
    expect(sql).not.toMatch(/profiles\.role\s*=\s*'admin'/);
    expect(sql).not.toMatch(/staff_has_page_access/);
    expect(sql).not.toMatch(/current_user\s*=\s*'postgres'/);
    expect(sql).toMatch(/DELETE FROM public\.push_tokens/);
    expect(sql).toMatch(/log_driver_availability_event/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.force_driver_offline\(uuid, text\) TO authenticated/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.force_driver_offline\(uuid, text\) TO service_role/i);
    expect(sql).not.toMatch(/GRANT EXECUTE.*TO (PUBLIC|anon)/i);

    expect(rb).toMatch(/profiles p/);
    expect(rb).toMatch(/p\.role = 'admin'/);
    expect(rb).toMatch(/Not authorized to force this driver offline/);
    expect(rb).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.force_driver_offline\(uuid, text\) TO authenticated/i,
    );
    expect(rb).not.toMatch(/GRANT EXECUTE.*TO (PUBLIC|anon)/i);
  });
});
