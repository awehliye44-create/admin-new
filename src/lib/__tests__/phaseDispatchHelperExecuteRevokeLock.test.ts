/**
 * Lock: ACL revoke for dispatch/fare SECURITY DEFINER helpers.
 *
 * If this fails, fix the migration — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261112140000_phase_dispatch_helper_execute_revoke.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261112140000_phase_dispatch_helper_execute_revoke.sql';

const INTERNAL = [
  'resolve_negotiation_rebroadcast_fare',
  'ride_offer_dispatch_push_delivery',
  'ride_offer_enqueue_reminders',
] as const;

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phaseDispatchHelperExecuteRevokeLock', () => {
  it('revokes client execute and keeps service_role only on resolve_zone_surge', () => {
    const sql = read(CANONICAL);
    expect(sql).not.toMatch(/DRAFT \/ NOT APPLIED/);
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(sql).not.toMatch(/ALTER\s+FUNCTION/i);

    for (const name of INTERNAL) {
      expect(sql).toMatch(new RegExp(String.raw`REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.${name}\s*\(`, 'i'));
      expect(sql).toMatch(new RegExp(String.raw`FROM\s+authenticated`, 'i'));
      expect(sql).toMatch(new RegExp(String.raw`FROM\s+service_role`, 'i'));
      expect(sql).not.toMatch(
        new RegExp(String.raw`GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.${name}\s*\(`, 'i'),
      );
    }

    expect(sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.resolve_zone_surge\s*\(\s*uuid\s*,\s*double precision\s*,\s*double precision\s*\)\s+FROM\s+authenticated/i,
    );
    expect(sql).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.resolve_zone_surge\s*\(\s*uuid\s*,\s*double precision\s*,\s*double precision\s*\)\s+TO\s+service_role/i,
    );
  });

  it('rollback restores authenticated execute and does not rewrite bodies', () => {
    const rb = read(ROLLBACK);
    expect(rb).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(rb).toMatch(/resolve_negotiation_rebroadcast_fare\(uuid\)\s+TO\s+authenticated/i);
    expect(rb).toMatch(/ride_offer_dispatch_push_delivery\(uuid, boolean\)\s+TO\s+service_role/i);
    expect(rb).toMatch(/ride_offer_enqueue_reminders\(uuid\)\s+TO\s+authenticated/i);
    expect(rb).toMatch(/resolve_zone_surge\(uuid, double precision, double precision\)\s+TO\s+authenticated/i);
    expect(rb).toMatch(/resolve_zone_surge\(uuid, double precision, double precision\)\s+TO\s+service_role/i);
  });
});
