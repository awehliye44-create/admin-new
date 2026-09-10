/**
 * Lock: Phase A8B15 orphan / postgres-internal driver trip helper EXECUTE draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109300000_phase_a8b15_orphan_driver_trip_helper_execute_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109300000_phase_a8b15_orphan_driver_trip_helper_execute_lock.sql';

const ORPHANED = [
  'is_customer(uuid)',
  'get_marketplace_delivery_config(uuid)',
  'resolve_driver_tier_category_priority(uuid, uuid)',
];

const POSTGRES_INTERNAL_WITH_SERVICE_BASELINE = [
  'driver_lost_property_public_trip_ref(uuid)',
  'driver_is_assigned_to_live_trip(uuid, uuid)',
  'driver_is_excluded_from_trip(uuid, uuid)',
  'driver_location_state_for_driver(uuid)',
  'driver_location_is_frozen(uuid)',
  'resolve_driver_tier_name(uuid)',
];

const POSTGRES_INTERNAL_AUTH_ONLY_BASELINE = [
  'validate_driver_signup_region_service_areas(uuid, uuid[])',
];

const EXPECTED_BODY_MD5: Record<string, string> = {
  is_customer: 'bb3ce42cef400bf24a5902a852835ad7',
  get_marketplace_delivery_config: 'dffe70e9cae0e5d209f6c7998d2d8c17',
  resolve_driver_tier_category_priority: '88945cc13b8a131bf0b7d2e391391451',
  driver_lost_property_public_trip_ref: 'ee2f5aba2ee667bbe6b6015c51d01944',
  driver_is_assigned_to_live_trip: '056d2586ffe57a4bff7f640e6808b0d4',
  driver_is_excluded_from_trip: 'e63b62a3e89a896acdba8c9d29a35401',
  driver_location_state_for_driver: '2069d2642c7fdee1523d5ca8f502ee5f',
  driver_location_is_frozen: 'b5a397b63aace864e12b3dafdee8a235',
  resolve_driver_tier_name: '56843aff56039152dd0bc0a935308e65',
  validate_driver_signup_region_service_areas: 'f936067e153997b545795321741aee24',
};

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('phaseA8B15OrphanDriverTripHelperExecuteLock', () => {
  it('ACL-locks ten orphan/postgres-internal helpers without body changes', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*\bTO anon\b/i);
    expect(rb).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*\bTO PUBLIC\b/i);

    const all = [
      ...ORPHANED,
      ...POSTGRES_INTERNAL_WITH_SERVICE_BASELINE,
      ...POSTGRES_INTERNAL_AUTH_ONLY_BASELINE,
    ];
    for (const sig of all) {
      const s = esc(sig);
      for (const role of ['PUBLIC', 'anon', 'authenticated', 'service_role']) {
        expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM ${role}`, 'i'));
      }
      expect(sql).not.toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'),
      );
      expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO authenticated`, 'i'));
    }

    for (const sig of [...ORPHANED, ...POSTGRES_INTERNAL_WITH_SERVICE_BASELINE]) {
      const s = esc(sig);
      expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'));
    }
    for (const sig of POSTGRES_INTERNAL_AUTH_ONLY_BASELINE) {
      const s = esc(sig);
      expect(rb).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'));
    }

    for (const [name, md5] of Object.entries(EXPECTED_BODY_MD5)) {
      expect(sql).toContain(`${name}: ${md5}`);
    }

    expect(all).toHaveLength(10);
    expect(sql).toMatch(/129 → 119/);
    expect(sql).toMatch(/is_driver — rematch trigger/i);
  });
});
