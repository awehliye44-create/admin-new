/**
 * Lock: Phase A8B12 identity/permission-helper EXECUTE draft.
 * If this fails, fix the draft — never delete or soften the lock.
 *
 * Note: staff_has_action authenticated EXECUTE was later restored by
 * 20261224140000_staff_has_action_authenticated_execute_restore.sql because
 * Admin RLS invokes it as the invoker. That restore is locked separately.
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

const HARD_STOP_NO_ACL = [
  'admin_assign_staff_role',
  'admin_create_staff_member',
  'approve_corporate_request',
  'suspend_corporate_request',
  'force_driver_offline',
  'ride_offer_dispatch_push_delivery',
  'ride_offer_enqueue_reminders',
  'submit_driver_location_sample',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip `--` line comments so exclusion lists in the header do not trip ACL checks. */
function aclStatementsOnly(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
}

describe('phaseA8B12IdentityHelperExecuteLock', () => {
  it('ACL-locks ten identity/helper functions without body changes', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    const sqlAcl = aclStatementsOnly(sql);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sqlAcl).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sqlAcl).not.toMatch(/FROM postgres/i);
    expect(aclStatementsOnly(rb)).not.toMatch(/\bREVOKE\b/i);
    // Rollback may mention anon/PUBLIC in comments; it must not GRANT them EXECUTE.
    expect(rb).not.toMatch(/GRANT\s+EXECUTE[\s\S]*?\bTO\s+anon\b/i);
    expect(rb).not.toMatch(/GRANT\s+EXECUTE[\s\S]*?\bTO\s+PUBLIC\b/i);

    // Mounted staff mutators / corporate approve must not be ACL-revoked here.
    for (const name of HARD_STOP_NO_ACL) {
      expect(sqlAcl).not.toMatch(new RegExp(name, 'i'));
    }

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
