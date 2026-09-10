/**
 * Lock: Phase A8B14 orphan / postgres-internal driver online helper EXECUTE draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109290000_phase_a8b14_orphan_driver_online_helper_execute_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109290000_phase_a8b14_orphan_driver_online_helper_execute_lock.sql';

const ORPHANED = [
  'driver_availability_ssot(uuid, integer, integer, integer, boolean)',
  'driver_effective_online_snapshot(uuid, integer, integer, integer, boolean)',
  'driver_effective_online_reason(uuid, integer, integer, integer, boolean)',
  'driver_freshness_reason(uuid, integer, integer, integer, boolean)',
  'driver_presence_last_signal_at(uuid)',
  'can_modify_trip(uuid)',
  'ride_offer_is_on_voluntary_decline_cooldown(uuid, uuid, integer)',
  'towards_destination_business_date(uuid)',
];

const POSTGRES_INTERNAL_ONLY = [
  'get_driver_identity_verification_gate(uuid)',
  'driver_has_accepted_active_or_stacked_work(uuid)',
];

const EXPECTED_BODY_MD5: Record<string, string> = {
  driver_availability_ssot: '7bfe41126b0943932203b98a8ca33aef',
  driver_effective_online_snapshot: 'e0f1e77a452032084f1b5b046caa691e',
  driver_effective_online_reason: '8a1f85a7c4833370c347c29652401eca',
  driver_freshness_reason: '8bdcebf9809811c590876348e5cd9385',
  driver_presence_last_signal_at: '243b942b35903ee3f34310cdac5a694d',
  can_modify_trip: '577acc1711d11bde0b283d00f0e8139e',
  ride_offer_is_on_voluntary_decline_cooldown: '7c7f3bb7c19607c82e5fc3e02f7c09a1',
  towards_destination_business_date: 'eab15f0bc302a8afb9bea42b1042b3b8',
  get_driver_identity_verification_gate: '29403d5d03dda8acb8b38c6324ee0cb5',
  driver_has_accepted_active_or_stacked_work: '736feddece8d9987ce177d8102e04297',
};

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('phaseA8B14OrphanDriverOnlineHelperExecuteLock', () => {
  it('ACL-locks ten orphan/postgres-internal helpers without body changes', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*\bTO anon\b/i);
    expect(rb).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*\bTO PUBLIC\b/i);

    const all = [...ORPHANED, ...POSTGRES_INTERNAL_ONLY];
    for (const sig of all) {
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

    for (const [name, md5] of Object.entries(EXPECTED_BODY_MD5)) {
      expect(sql).toContain(`${name}: ${md5}`);
    }

    expect(ORPHANED).toHaveLength(8);
    expect(POSTGRES_INTERNAL_ONLY).toHaveLength(2);
    expect(all).toHaveLength(10);
    expect(sql).toMatch(/139 → 129/);
  });
});
