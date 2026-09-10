/**
 * Lock: Phase A8B17 Edge-service demand-zone audit helper EXECUTE draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109320000_phase_a8b17_edge_demand_zone_audit_execute_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109320000_phase_a8b17_edge_demand_zone_audit_execute_lock.sql';

const EDGE_SERVICE_ONLY = [
  'log_demand_zone_event(uuid, uuid, text, jsonb, jsonb, text)',
];

const EXPECTED_BODY_MD5: Record<string, string> = {
  log_demand_zone_event: '981c5d6050a4de8a5c247c0d9ec346ee',
};

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('phaseA8B17EdgeDemandZoneAuditExecuteLock', () => {
  it('ACL-locks one Edge-service demand-zone audit helper without body changes', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(sql).toMatch(/Retain service_role EXECUTE/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*\bTO anon\b/i);
    expect(rb).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*\bTO PUBLIC\b/i);

    for (const sig of EDGE_SERVICE_ONLY) {
      const s = esc(sig);
      for (const role of ['PUBLIC', 'anon', 'authenticated']) {
        expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM ${role}`, 'i'));
      }
      expect(sql).not.toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM service_role`, 'i'),
      );
      expect(sql).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'),
      );
      expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO authenticated`, 'i'));
      expect(rb).not.toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'),
      );
    }

    for (const [name, md5] of Object.entries(EXPECTED_BODY_MD5)) {
      expect(sql).toContain(`${name}: ${md5}`);
    }

    expect(EDGE_SERVICE_ONLY).toHaveLength(1);
    expect(sql).toMatch(/117 → 116/);
    expect(sql).toMatch(/requireDemandZoneRecomputeAuth/);
    expect(sql).toMatch(/resolve_zone_surge/);
  });
});
