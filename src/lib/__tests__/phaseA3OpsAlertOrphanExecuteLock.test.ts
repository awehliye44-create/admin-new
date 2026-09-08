/**
 * Lock: Phase A3 orphan Ops Alert EXECUTE revoke draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "../../..");
const CANONICAL = "supabase/migrations/20261109020000_phase_a3_ops_alert_orphan_execute_revoke_lock.sql";
const ROLLBACK = "supabase/migrations/rollback/rollback_20261109020000_phase_a3_ops_alert_orphan_execute_revoke_lock.sql";

const SIGNATURES = [
  "ops_acknowledge_alert(uuid, uuid)",
  "ops_resolve_alert(uuid, uuid)",
  "ops_suppress_alert(uuid, timestamptz)",
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("phaseA3OpsAlertOrphanExecuteLock", () => {
  it("revokes client EXECUTE without changing bodies or restoring public access", () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    const detail = read("src/components/ops/OpsAlertDetail.tsx");
    const app = read("src/App.tsx");

    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\./i);
    expect(sql).not.toMatch(/role_page_permissions/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(rb).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.\w+ TO PUBLIC/i);
    expect(rb).not.toMatch(/TO anon/i);

    for (const sig of SIGNATURES) {
      const s = esc(sig);
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM PUBLIC`, "i"));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM anon`, "i"));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM authenticated`, "i"));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM service_role`, "i"));
      expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO authenticated`, "i"));
      expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, "i"));
    }

    expect(detail).toMatch(/ops_acknowledge_alert/);
    expect(app).not.toMatch(/OpsAlertDetail/);
    expect(SIGNATURES).toHaveLength(3);
  });
});
