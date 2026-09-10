/**
 * Lock: Phase A8B10 finance-assert / edge / postgres-internal EXECUTE draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109220000_phase_a8b10_finance_assert_and_internal_execute_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109220000_phase_a8b10_finance_assert_and_internal_execute_lock.sql';

const EDGE_SERVICE_ONLY = ['passenger_has_live_immediate_trip(uuid, uuid)'];

const POSTGRES_INTERNAL = [
  'assert_finance_payout_ledger_access()',
  'assert_driver_wallet_read_access(uuid)',
  'get_dispatch_settings(uuid)',
  'towards_destination_clear_filter(uuid)',
  'towards_destination_resolve_config(uuid)',
  'towards_destination_usage_snapshot(uuid, integer)',
  'is_stale_unverified_email_identity(uuid, text, text, timestamp with time zone)',
  'is_stale_unverified_phone_identity(uuid, text, text, timestamp with time zone)',
  'allow_driver_availability_write()',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('phaseA8B10FinanceAssertAndInternalExecuteLock', () => {
  it('ACL-locks ten finance-assert/edge/postgres helpers without body changes', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/\banon\b/i);
    expect(rb).not.toMatch(/\bPUBLIC\b/);

    // Mounted Admin payout mutators must remain authenticated (not revoked here).
    expect(sql).not.toMatch(/ops_retry_failed_payout_item/i);
    expect(sql).not.toMatch(/return_failed_payout_to_wallet/i);
    expect(sql).not.toMatch(/suspend_corporate_request/i);

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

    expect(EDGE_SERVICE_ONLY).toHaveLength(1);
    expect(POSTGRES_INTERNAL).toHaveLength(9);
  });
});
