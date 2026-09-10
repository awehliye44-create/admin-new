/**
 * Lock: Phase A8B12 identity/permission-helper EXECUTE draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109240000_phase_a8b12_identity_helper_execute_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109240000_phase_a8b12_identity_helper_execute_lock.sql';

const EDGE_SERVICE_ONLY = [
  'check_email_available_for_change(text, uuid)',
  'check_phone_available_for_change(uuid, text, text)',
  'staff_has_action(uuid, text)',
];

const POSTGRES_INTERNAL = [
  'phone_is_pending_reserved(text, uuid)',
  'phone_is_verified_protected(text, uuid)',
  'haversine_meters(double precision, double precision, double precision, double precision)',
  'dispatch_max_driver_find_minutes(uuid)',
  'log_driver_availability_event(uuid, text, text, boolean, boolean, boolean, boolean, jsonb, text)',
  'assert_driver_presence_online_eligible(uuid)',
  'recalculate_driver_documents_approved(uuid)',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('phaseA8B12IdentityHelperExecuteLock', () => {
  it('ACL-locks ten identity/helper functions without body changes', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/\banon\b/i);
    expect(rb).not.toMatch(/\bPUBLIC\b/);

    // Mounted staff mutators / corporate approve must not be ACL-revoked here.
    expect(sql).not.toMatch(/admin_assign_staff_role/i);
    expect(sql).not.toMatch(/admin_create_staff_member/i);
    expect(sql).not.toMatch(/approve_corporate_request/i);
    expect(sql).not.toMatch(/suspend_corporate_request/i);
    expect(sql).not.toMatch(/force_driver_offline/i);
    expect(sql).not.toMatch(/ride_offer_dispatch_push_delivery/i);
    expect(sql).not.toMatch(/ride_offer_enqueue_reminders/i);
    expect(sql).not.toMatch(/submit_driver_location_sample/i);

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

    for (const sig of POSTGRES_INTERNAL) {
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

    expect(EDGE_SERVICE_ONLY).toHaveLength(3);
    expect(POSTGRES_INTERNAL).toHaveLength(7);
  });
});
