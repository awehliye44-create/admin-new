/**
 * Lock: Phase A8B19 get_driver_resume_delta EXECUTE draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109340000_phase_a8b19_driver_resume_delta_execute_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109340000_phase_a8b19_driver_resume_delta_execute_lock.sql';

const SIG =
  'get_driver_resume_delta(timestamp with time zone, uuid, uuid)';

const EXPECTED_BODY_MD5 = 'e67909a7cb847acbb686306b54ff5b59';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('phaseA8B19DriverResumeDeltaExecuteLock', () => {
  it('ACL-locks orphan resume-delta helper without body or workflow changes', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(sql).toMatch(/get_driver_active_trip_snapshot/i);
    expect(sql).toMatch(/get_driver_pending_ride_offers/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*\bTO anon\b/i);
    expect(rb).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*\bTO PUBLIC\b/i);

    const s = esc(SIG);
    for (const role of ['PUBLIC', 'anon', 'authenticated', 'service_role']) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM ${role}`, 'i'));
    }
    expect(sql).not.toMatch(
      new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'),
    );
    expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO authenticated`, 'i'));
    expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'));
    expect(sql).toContain(EXPECTED_BODY_MD5);
    expect(sql).toMatch(/111 → 110/i);
  });
});
