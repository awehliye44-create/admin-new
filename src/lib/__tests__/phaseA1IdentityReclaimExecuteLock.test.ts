/**
 * Lock: Phase A1 identity reclaim EXECUTE draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261107224000_phase_a1_identity_reclaim_execute_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261107224000_phase_a1_identity_reclaim_execute_lock.sql';

const SIGNATURES = [
  'reclaim_stale_onboarding_auth_user(text)',
  'repair_user_stale_auth_identities(uuid)',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('phaseA1IdentityReclaimExecuteLock', () => {
  it('revokes client EXECUTE on both signatures and keeps service_role', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(sql).not.toMatch(/cron\.unschedule/i);
    expect(sql).not.toMatch(/REVOKE ALL ON FUNCTION public\.[a-z0-9_]+\([^)]*\) FROM service_role/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    for (const sig of SIGNATURES) {
      const s = esc(sig);
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM PUBLIC`, 'i'));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM anon`, 'i'));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM authenticated`, 'i'));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'));
      expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO authenticated`, 'i'));
      expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'));
    }
    expect(SIGNATURES).toHaveLength(2);
  });
});
