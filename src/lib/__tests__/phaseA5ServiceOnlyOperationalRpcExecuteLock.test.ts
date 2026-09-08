/**
 * Lock: Phase A5 service-only operational RPC EXECUTE draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "../../..");
const CANONICAL = "supabase/migrations/20261109040000_phase_a5_service_only_operational_rpc_execute_lock.sql";
const ROLLBACK = "supabase/migrations/rollback/rollback_20261109040000_phase_a5_service_only_operational_rpc_execute_lock.sql";

const EDGE_SERVICE_ROLE = [
  "resolve_active_company_operational_reserve_prefer_sa(uuid, text, timestamp with time zone)",
  "get_performance_p95(text, integer)",
  "generate_lost_property_case_number(uuid)",
];

const POSTGRES_ONLY = [
  "resolve_active_company_operational_reserve(uuid, text, timestamp with time zone)",
  "resolve_service_area_outbound_caller_id(uuid)",
  "resolve_service_area_communication(uuid)",
  "get_p95_action_metrics(text, integer, text, text)",
  "get_p95_screen_metrics(text, text)",
  "get_performance_baseline_verdicts(text)",
  "record_push_send_result(text, boolean, text, text, jsonb)",
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("phaseA5ServiceOnlyOperationalRpcExecuteLock", () => {
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

    for (const sig of [...EDGE_SERVICE_ROLE, ...POSTGRES_ONLY]) {
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
    for (const sig of POSTGRES_ONLY) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${esc(sig)} FROM service_role`, "i"));
    }
  });
});
