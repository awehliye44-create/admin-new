/**
 * Lock: Phase A8B7 orphan/dispatch mutator EXECUTE draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109190000_phase_a8b7_orphan_dispatch_mutator_execute_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109190000_phase_a8b7_orphan_dispatch_mutator_execute_lock.sql';

const ORPHAN_OR_INTERNAL = [
  'lock_driver_vehicle(uuid)',
  'mark_driver_background_unavailable(uuid)',
  'merge_ride_offer_push_log(uuid, jsonb)',
  'driver_cancel_negotiation(uuid, uuid)',
  'release_trip_negotiation_lock(uuid, text)',
  'stop_driver_commitment_session(uuid, text)',
  'record_driver_commitment_warning(uuid, text, text)',
  'sync_document_primary_file_url(uuid)',
];

const EDGE_SERVICE_ONLY = [
  'log_dispatch_event(uuid, text, integer, uuid, jsonb)',
  'record_dispatch_wave_snapshot(uuid, integer, text, integer, uuid, text, uuid, jsonb)',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('phaseA8B7OrphanDispatchMutatorExecuteLock', () => {
  it('applies ACL-only revoke patterns by classification', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(sql).not.toMatch(/cron\.unschedule/i);

    for (const sig of ORPHAN_OR_INTERNAL) {
      const s = esc(sig);
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM PUBLIC`, 'i'));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM anon`, 'i'));
      expect(sql).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM authenticated`, 'i'),
      );
      expect(sql).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM service_role`, 'i'),
      );
      expect(sql).not.toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'),
      );
      expect(rb).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO authenticated`, 'i'),
      );
      expect(rb).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'),
      );
    }

    for (const sig of EDGE_SERVICE_ONLY) {
      const s = esc(sig);
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM PUBLIC`, 'i'));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM anon`, 'i'));
      expect(sql).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM authenticated`, 'i'),
      );
      expect(sql).not.toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM service_role`, 'i'),
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

    expect(ORPHAN_OR_INTERNAL).toHaveLength(8);
    expect(EDGE_SERVICE_ONLY).toHaveLength(2);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
  });
});
