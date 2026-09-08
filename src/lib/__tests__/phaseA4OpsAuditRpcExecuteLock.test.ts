/**
 * Lock: Phase A4 Edge-only Ops and audit RPC EXECUTE draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "../../..");
const CANONICAL = "supabase/migrations/20261109030000_phase_a4_ops_audit_rpc_execute_lock.sql";
const ROLLBACK = "supabase/migrations/rollback/rollback_20261109030000_phase_a4_ops_audit_rpc_execute_lock.sql";

const EDGE_SERVICE_ROLE = [
  "ops_resolve_alert_if_cleared(uuid)",
  "ops_upsert_alert(text, text, text, text, text, text, text, uuid, uuid, uuid, uuid, text, text, jsonb)",
  "ops_ingest_workflow_event(text, text, text, uuid, uuid, uuid, text, integer, text, text, text, text, text, text, jsonb, boolean)",
  "ops_run_all_detections()",
  "log_audit_event(text, uuid, uuid, uuid, jsonb, text, text)",
];

const UNUSED = [
  "ops_record_event(text, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, integer, text, text, jsonb, boolean)",
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("phaseA4OpsAuditRpcExecuteLock", () => {
  it("removes authenticated EXECUTE and keeps service_role only for proven Edge callers", () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(sql).not.toMatch(/GRANT EXECUTE/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/TO anon/i);
    expect(rb).not.toMatch(/TO PUBLIC/i);

    for (const sig of [...EDGE_SERVICE_ROLE, ...UNUSED]) {
      const s = esc(sig);
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM PUBLIC`, "i"));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM anon`, "i"));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM authenticated`, "i"));
      expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO authenticated`, "i"));
      expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, "i"));
    }

    for (const sig of EDGE_SERVICE_ROLE) {
      expect(sql).not.toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${esc(sig)} FROM service_role`, "i"));
    }
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${esc(UNUSED[0])} FROM service_role`, "i"));
  });
});
