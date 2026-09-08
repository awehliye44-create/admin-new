/**
 * Lock: Phase 3 Batch 3E2 Edge maintenance EXECUTE draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL = 'supabase/migrations/20261107221000_phase3_batch3e2_edge_maintenance_execute_lock.sql';
const ROLLBACK = 'supabase/migrations/rollback/rollback_20261107221000_phase3_batch3e2_edge_maintenance_execute_lock.sql';

const SIGNATURES = [
  'expire_stale_offers()',
  'expire_trip_when_search_exhausted(uuid)',
  'process_ride_offer_ack_timeouts()',
  'lost_property_expire_chats()',
  'lost_property_get_cases_for_photo_cleanup()',
  'expire_due_call_masking_sessions()',
  'ops_auto_resolve_stale_alerts(integer)',
  'timeout_scheduled_offer(uuid, uuid)',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('phase3Batch3e2EdgeMaintenanceExecuteLock', () => {
  it('keeps service_role only because every signature has a proven Edge caller', () => {
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
    expect(SIGNATURES).toHaveLength(8);
  });
});
