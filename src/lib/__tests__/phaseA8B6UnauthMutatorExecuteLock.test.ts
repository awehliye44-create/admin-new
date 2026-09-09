/**
 * Lock: Phase A8B6 unauthenticated mutator EXECUTE draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109180000_phase_a8b6_unauth_mutator_execute_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109180000_phase_a8b6_unauth_mutator_execute_lock.sql';

const SIGNATURES = [
  'allocate_driver_reference(uuid)',
  'allocate_trip_reference(uuid, timestamp with time zone)',
  'assign_trip_number(uuid, uuid)',
  'enrich_ride_offer_presets(uuid)',
  'ensure_trip_stops_for_assignment(uuid)',
  'log_dispatch_eligibility(uuid, uuid, boolean, text, jsonb)',
  'ops_retry_failed_dispatch(uuid)',
  'recalculate_driver_display_rating(uuid)',
  'start_driver_commitment_session(uuid, uuid)',
  'upsert_driver_live_location(uuid, double precision, double precision, text, real, real)',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('phaseA8B6UnauthMutatorExecuteLock', () => {
  it('revokes authenticated EXECUTE while retaining service_role; ACL-only', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(sql).not.toMatch(/cron\.unschedule/i);
    expect(sql).not.toMatch(
      /REVOKE ALL ON FUNCTION public\.[a-z0-9_]+\([^)]*\) FROM service_role/i,
    );
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    for (const sig of SIGNATURES) {
      const s = esc(sig);
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM PUBLIC`, 'i'));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM anon`, 'i'));
      expect(sql).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM authenticated`, 'i'),
      );
      expect(sql).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'),
      );
      expect(rb).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO authenticated`, 'i'),
      );
      expect(rb).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'),
      );
    }
    expect(SIGNATURES).toHaveLength(10);
  });
});
