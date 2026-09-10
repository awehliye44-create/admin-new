/**
 * Lock: Phase A8B16 postgres-internal driver alert helper EXECUTE draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109310000_phase_a8b16_driver_alert_helper_execute_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109310000_phase_a8b16_driver_alert_helper_execute_lock.sql';

const POSTGRES_INTERNAL = [
  'raise_driver_alert(uuid, text, driver_alert_severity, text, uuid, jsonb)',
  'resolve_driver_alert(uuid, text)',
];

const EXPECTED_BODY_MD5: Record<string, string> = {
  raise_driver_alert: '37de48bae4231106a30e32c49fe3dacd',
  resolve_driver_alert: '648a13b0f8de4e35f836676afe9b21e2',
};

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('phaseA8B16DriverAlertHelperExecuteLock', () => {
  it('ACL-locks two postgres-internal alert helpers without body changes', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*\bTO anon\b/i);
    expect(rb).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*\bTO PUBLIC\b/i);

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

    for (const [name, md5] of Object.entries(EXPECTED_BODY_MD5)) {
      expect(sql).toContain(`${name}: ${md5}`);
    }

    expect(POSTGRES_INTERNAL).toHaveLength(2);
    expect(sql).toMatch(/119 → 117/);
    expect(sql).toMatch(/detect_driver_problems/i);
    expect(sql).toMatch(/resolve_zone_surge/i);
  });
});
