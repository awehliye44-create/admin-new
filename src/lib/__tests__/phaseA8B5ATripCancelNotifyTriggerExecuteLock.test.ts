/**
 * Lock: Phase A8B5A trip-cancel notify trigger-chain EXECUTE ACL draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "../../..");
const CANONICAL =
  "supabase/migrations/20261109160000_phase_a8b5a_trip_cancel_notify_trigger_execute_lock.sql";
const ROLLBACK =
  "supabase/migrations/rollback/rollback_20261109160000_phase_a8b5a_trip_cancel_notify_trigger_execute_lock.sql";
const NOTIFY = "public\\.notify_drivers_trip_cancelled\\(uuid, text\\)";
const TRIG = "public\\.tr_trips_notify_cancel\\(\\)";

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("phaseA8B5ATripCancelNotifyTriggerExecuteLock", () => {
  it("revokes client EXECUTE on notify child and trigger fn without body/trigger changes", () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/DROP TRIGGER/i);
    expect(sql).not.toMatch(/DISABLE TRIGGER/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE TRIGGER/i);
    expect(sql).not.toMatch(/FROM postgres/i);

    for (const sig of [NOTIFY, TRIG]) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC`, "i"));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${sig} FROM anon`, "i"));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${sig} FROM authenticated`, "i"));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${sig} FROM service_role`, "i"));
    }

    expect(sql).toMatch(/198 → 197|198 -> 197/);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/TO anon/i);
    expect(rb).not.toMatch(/TO PUBLIC/i);
    expect(rb).toMatch(
      new RegExp(`GRANT EXECUTE ON FUNCTION ${NOTIFY} TO authenticated`, "i"),
    );
    expect(rb).toMatch(
      new RegExp(`GRANT EXECUTE ON FUNCTION ${NOTIFY} TO service_role`, "i"),
    );
    expect(rb).toMatch(
      new RegExp(`GRANT EXECUTE ON FUNCTION ${TRIG} TO service_role`, "i"),
    );
    expect(rb).not.toMatch(
      new RegExp(`GRANT EXECUTE ON FUNCTION ${TRIG} TO authenticated`, "i"),
    );
    expect(rb).not.toMatch(/PERFORM public\.notify_drivers_trip_cancelled/i);
  });
});
