/**
 * Lock: Phase A8B9 orphan / edge / postgres-internal EXECUTE draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109210000_phase_a8b9_orphan_edge_postgres_execute_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109210000_phase_a8b9_orphan_edge_postgres_execute_lock.sql';

const EDGE_SERVICE_ONLY = ['get_active_stop_waiting(uuid)'];

const ORPHAN_OR_INTERNAL = [
  'is_user_suspended(uuid, text)',
  'driver_cancel_before_start_rematch(uuid, uuid, text, text, jsonb)',
  'is_driver_dispatchable(uuid, integer, boolean, integer)',
  'get_customer_trip_stats(uuid)',
  'get_corporate_allowed_payment_methods(uuid)',
  'staff_role_of(uuid)',
  'towards_destination_complete_session(uuid, text)',
  'towards_destination_maybe_complete_on_location(uuid, double precision, double precision)',
  'compute_ride_offer_preset_options(trips)',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('phaseA8B9OrphanEdgePostgresExecuteLock', () => {
  it('ACL-locks ten orphan/edge/postgres helpers without body changes', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/\banon\b/i);
    expect(rb).not.toMatch(/\bPUBLIC\b/);

    for (const sig of EDGE_SERVICE_ONLY) {
      const s = esc(sig);
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM authenticated`, 'i'));
      expect(sql).not.toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM service_role`, 'i'),
      );
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'));
      expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO authenticated`, 'i'));
      expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'));
    }

    for (const sig of ORPHAN_OR_INTERNAL) {
      const s = esc(sig);
      for (const role of ['PUBLIC', 'anon', 'authenticated', 'service_role']) {
        expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM ${role}`, 'i'));
      }
      expect(sql).not.toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'),
      );
      expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO authenticated`, 'i'));
      expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'));
    }

    expect(EDGE_SERVICE_ONLY).toHaveLength(1);
    expect(ORPHAN_OR_INTERNAL).toHaveLength(9);
  });
});
