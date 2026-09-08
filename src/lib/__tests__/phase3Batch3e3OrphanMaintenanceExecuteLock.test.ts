/**
 * Lock: Phase 3 Batch 3E3 orphan maintenance EXECUTE draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL = 'supabase/migrations/20261107222000_phase3_batch3e3_orphan_maintenance_execute_lock.sql';
const ROLLBACK = 'supabase/migrations/rollback/rollback_20261107222000_phase3_batch3e3_orphan_maintenance_execute_lock.sql';

const SIGNATURES = [
  'expire_stale_negotiations()',
  'expire_stale_negotiations_guarded()',
  'expire_stale_modification_requests()',
  'sweep_stale_searching_trips()',
  'expire_negotiation_offer(uuid)',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('phase3Batch3e3OrphanMaintenanceExecuteLock', () => {
  it('denies service_role because no signature has a proven Edge caller', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(sql).not.toMatch(/cron\.unschedule/i);
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\./i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    for (const sig of SIGNATURES) {
      const s = esc(sig);
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM PUBLIC`, 'i'));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM anon`, 'i'));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM authenticated`, 'i'));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM service_role`, 'i'));
      expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO authenticated`, 'i'));
      expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'));
    }
    expect(SIGNATURES).toHaveLength(5);
  });
});
