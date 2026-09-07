/**
 * Lock: Phase 3 Batch 3C dispatch/trip-state Edge-only RPC EXECUTE revoke.
 * If this fails, fix the migration — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261107200000_phase3_batch3c_dispatch_trip_rpc_execute_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261107200000_phase3_batch3c_dispatch_trip_rpc_execute_lock.sql';

const THIRTEEN: { name: string; args: string }[] = [
  { name: 'accept_ride_offer', args: 'uuid, uuid, boolean' },
  { name: 'decline_ride_offer', args: 'uuid, uuid' },
  { name: 'decline_ride_offer', args: 'uuid, uuid, text' },
  { name: 'commit_dispatch_wave', args: 'uuid, integer, jsonb, integer' },
  { name: 'commit_negotiation_fare', args: 'uuid, integer, text, uuid, uuid' },
  { name: 'complete_trip_and_promote_next', args: 'uuid, uuid, bigint, timestamp with time zone' },
  { name: 'apply_terminal_trip_cancellation', args: 'uuid, text, text' },
  { name: 'finalize_paid_booking_session', args: 'uuid' },
  { name: 'accept_stacked_ride', args: 'uuid, uuid, uuid' },
  { name: 'customer_counter_ride_offer', args: 'uuid, integer, uuid, uuid' },
  { name: 'driver_accept_counter_offer', args: 'uuid, uuid' },
  { name: 'finalize_negotiated_fare', args: 'uuid, uuid, integer, text, uuid' },
  { name: 'finalize_negotiation_failure', args: 'uuid, uuid, uuid, text, text' },
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function sig(fn: { name: string; args: string }): string {
  return `public.${fn.name}(${fn.args})`;
}

function lit(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('phase3Batch3cDispatchTripRpcExecuteLock', () => {
  it('revokes PUBLIC, anon and authenticated without changing bodies', () => {
    const sql = read(CANONICAL);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
    expect(sql).not.toMatch(/ALTER\s+FUNCTION/i);
    expect(sql).not.toMatch(/DROP FUNCTION/i);
    for (const fn of THIRTEEN) {
      const s = lit(sig(fn));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM PUBLIC`, 'i'));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM anon`, 'i'));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM authenticated`, 'i'));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'));
      expect(sql).not.toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM service_role`, 'i'));
      expect(sql).not.toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM postgres`, 'i'));
    }
  });

  it('rollback restores authenticated EXECUTE only', () => {
    const rb = read(ROLLBACK);
    expect(rb).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    for (const fn of THIRTEEN) {
      expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${lit(sig(fn))} TO authenticated`, 'i'));
    }
  });
});
