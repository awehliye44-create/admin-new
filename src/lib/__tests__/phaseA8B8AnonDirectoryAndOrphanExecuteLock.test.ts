/**
 * Lock: Phase A8B8 anon directory + orphan/edge mutator EXECUTE draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109200000_phase_a8b8_anon_directory_and_orphan_execute_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109200000_phase_a8b8_anon_directory_and_orphan_execute_lock.sql';

const AUTH_REQUIRED = ['admin_user_directory()'];

const ORPHAN_OR_INTERNAL = [
  'adjust_merchant_credits(uuid, integer, text)',
  'approve_merchant_with_credits(uuid, text)',
  'get_driver_wallet_balance(uuid)',
  'reject_roles_action(text, text, jsonb)',
  'log_roles_audit(text, jsonb)',
  'accept_ride_offer_eligibility_guard(uuid)',
  'dispatchable_reason(uuid, integer, boolean, integer)',
];

const EDGE_SERVICE_ONLY = [
  'ops_retry_failed_payout(uuid)',
  'check_driver_documents_approved(uuid)',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('phaseA8B8AnonDirectoryAndOrphanExecuteLock', () => {
  it('revokes anon on directory; ACL-locks orphans/edge/postgres helpers', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/\banon\b/i);
    expect(rb).not.toMatch(/\bPUBLIC\b/);

    for (const sig of AUTH_REQUIRED) {
      const s = esc(sig);
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM PUBLIC`, 'i'));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM anon`, 'i'));
      expect(sql).not.toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM authenticated`, 'i'),
      );
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO authenticated`, 'i'));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'));
    }

    for (const sig of ORPHAN_OR_INTERNAL) {
      const s = esc(sig);
      for (const role of ['PUBLIC', 'anon', 'authenticated', 'service_role']) {
        expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM ${role}`, 'i'));
      }
      expect(sql).not.toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'),
      );
    }

    for (const sig of EDGE_SERVICE_ONLY) {
      const s = esc(sig);
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM authenticated`, 'i'));
      expect(sql).not.toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM service_role`, 'i'),
      );
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'));
    }

    expect(AUTH_REQUIRED).toHaveLength(1);
    expect(ORPHAN_OR_INTERNAL).toHaveLength(7);
    expect(EDGE_SERVICE_ONLY).toHaveLength(2);
  });
});
