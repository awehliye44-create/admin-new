/**
 * Lock: Phase A8B18 orphan driver/corporate helper EXECUTE draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109330000_phase_a8b18_orphan_driver_corporate_helper_execute_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109330000_phase_a8b18_orphan_driver_corporate_helper_execute_lock.sql';

const ORPHANED = [
  'list_driver_trip_history(integer)',
  'create_driver_vehicle(uuid, text, text, integer, text, text)',
  'get_driver_feedback_analytics(uuid)',
  'set_corporate_account_service_area(uuid, uuid)',
  'get_booking_quote_inputs(double precision, double precision)',
];

const EXPECTED_BODY_MD5: Record<string, string> = {
  list_driver_trip_history: 'f6d68a4b21c4debde3352290922f6045',
  create_driver_vehicle: '975936ecd766413f6e582f1b4165843c',
  get_driver_feedback_analytics: 'eddd9e01ad2db3b2569b23756451daa8',
  set_corporate_account_service_area: '6a046e1bb27c573a6cc18f7e5b395dc9',
  get_booking_quote_inputs: 'a83d567af63ee8b22fc49dc0763365e3',
};

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('phaseA8B18OrphanDriverCorporateHelperExecuteLock', () => {
  it('ACL-locks five orphan helpers without body changes', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*\bTO anon\b/i);
    expect(rb).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*\bTO PUBLIC\b/i);

    for (const sig of ORPHANED) {
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
      expect(sql).toMatch(new RegExp(`${name}[^\\n]*${md5}|${md5}[^\\n]*${name}`, 'i'));
      expect(sql).toContain(md5);
    }

    expect(sql).toMatch(/116 → 111/i);
    expect(ORPHANED).toHaveLength(5);
  });
});
