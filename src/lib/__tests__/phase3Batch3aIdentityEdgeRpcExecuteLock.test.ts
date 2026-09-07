/**
 * Lock: Phase 3 Batch 3A identity/auth Edge-only RPC EXECUTE revoke.
 * If this fails, fix the migration — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261107180000_phase3_batch3a_identity_edge_rpc_execute_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261107180000_phase3_batch3a_identity_edge_rpc_execute_lock.sql';

const THIRTEEN: { name: string; args: string }[] = [
  { name: 'reset_auth_user_email_unconfirmed', args: 'uuid' },
  { name: 'get_user_id_by_email', args: 'text' },
  { name: 'mark_account_email_verified', args: 'uuid, text' },
  { name: 'stage_phone_change', args: 'uuid, text, text' },
  { name: 'stage_email_change', args: 'uuid, text, text' },
  { name: 'clear_phone_change_pending', args: 'uuid, text' },
  { name: 'complete_phone_change_customer', args: 'uuid' },
  { name: 'complete_phone_change_driver', args: 'uuid' },
  { name: 'complete_email_change_customer', args: 'uuid, text' },
  { name: 'complete_email_change_driver', args: 'uuid, text' },
  { name: 'finalize_customer_onboarding', args: 'uuid' },
  { name: 'sync_customer_phone_verification', args: 'uuid' },
  { name: 'sync_driver_phone_verification', args: 'uuid' },
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function signature(fn: { name: string; args: string }): string {
  return `public.${fn.name}(${fn.args})`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('phase3Batch3aIdentityEdgeRpcExecuteLock', () => {
  it('revokes PUBLIC, anon and authenticated and preserves service_role on all 13 signatures', () => {
    const sql = read(CANONICAL);
    expect(sql).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
    expect(sql).not.toMatch(/ALTER\s+FUNCTION/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE/i);
    expect(sql).not.toMatch(/cron\.(schedule|unschedule)/i);
    expect(sql).toMatch(/NOT APPLIED/i);

    for (const fn of THIRTEEN) {
      const sig = signature(fn);
      const lit = escapeRegExp(sig);
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${lit} FROM PUBLIC`, 'i'));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${lit} FROM anon`, 'i'));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${lit} FROM authenticated`, 'i'));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${lit} TO service_role`, 'i'));
      expect(sql).not.toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${lit} FROM service_role`, 'i'));
      expect(sql).not.toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${lit} FROM postgres`, 'i'));
      expect(sql).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${lit} TO authenticated`, 'i'));
      expect(sql).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${lit} TO anon`, 'i'));
      expect(sql).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${lit} TO PUBLIC`, 'i'));
    }
  });

  it('rollback restores authenticated EXECUTE only — not PUBLIC or anon', () => {
    const rb = read(ROLLBACK);
    expect(rb).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/GRANT EXECUTE ON FUNCTION .+ TO (anon|PUBLIC|service_role)/i);
    for (const fn of THIRTEEN) {
      expect(rb).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION ${escapeRegExp(signature(fn))} TO authenticated`, 'i'),
      );
    }
  });
});
