/**
 * Lock: Phase A6 check_schedule_overlap EXECUTE draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "../../..");
const CANONICAL = "supabase/migrations/20261109050000_phase_a6_check_schedule_overlap_execute_lock.sql";
const ROLLBACK = "supabase/migrations/rollback/rollback_20261109050000_phase_a6_check_schedule_overlap_execute_lock.sql";
const SIG = "check_schedule_overlap(uuid, uuid)";

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("phaseA6CheckScheduleOverlapExecuteLock", () => {
  it("revokes authenticated and service_role because no proven caller exists", () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    const s = esc(SIG);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(sql).not.toMatch(/GRANT EXECUTE/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/TO anon/i);
    expect(rb).not.toMatch(/TO PUBLIC/i);
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM PUBLIC`, "i"));
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM anon`, "i"));
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM authenticated`, "i"));
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM service_role`, "i"));
    expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO authenticated`, "i"));
    expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, "i"));
  });
});
