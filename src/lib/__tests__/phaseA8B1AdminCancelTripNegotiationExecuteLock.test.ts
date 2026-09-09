/**
 * Lock: Phase A8B1 admin_cancel_trip_negotiation EXECUTE ACL draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "../../..");
const CANONICAL =
  "supabase/migrations/20261109120000_phase_a8b1_admin_cancel_trip_negotiation_execute_lock.sql";
const ROLLBACK =
  "supabase/migrations/rollback/rollback_20261109120000_phase_a8b1_admin_cancel_trip_negotiation_execute_lock.sql";
const SIG = "public.admin_cancel_trip_negotiation\\(uuid, text\\)";

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("phaseA8B1AdminCancelTripNegotiationExecuteLock", () => {
  it("revokes authenticated EXECUTE and retains service_role without body changes", () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${SIG} FROM PUBLIC`, "i"));
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${SIG} FROM anon`, "i"));
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${SIG} FROM authenticated`, "i"));
    expect(sql).not.toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${SIG} FROM service_role`, "i"));
    expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${SIG} TO service_role`, "i"));
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION .* TO authenticated/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/TO anon/i);
    expect(rb).not.toMatch(/TO PUBLIC/i);
    expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${SIG} TO authenticated`, "i"));
    expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${SIG} TO service_role`, "i"));
    expect(rb).not.toMatch(/PERFORM public\.admin_cancel_trip_negotiation/i);
  });
});
