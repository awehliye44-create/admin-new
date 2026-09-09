/**
 * Lock: Phase A8B3 promote_stacked_trip EXECUTE ACL draft + caller contract.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "../../..");
const CANONICAL =
  "supabase/migrations/20261109140000_phase_a8b3_promote_stacked_trip_execute_lock.sql";
const ROLLBACK =
  "supabase/migrations/rollback/rollback_20261109140000_phase_a8b3_promote_stacked_trip_execute_lock.sql";
const SIG = "public.promote_stacked_trip\\(uuid, uuid\\)";

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("phaseA8B3PromoteStackedTripExecuteLock", () => {
  it("revokes authenticated EXECUTE and retains service_role without body changes", () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${SIG} FROM PUBLIC`, "i"));
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${SIG} FROM anon`, "i"));
    expect(sql).toMatch(
      new RegExp(`REVOKE ALL ON FUNCTION ${SIG} FROM authenticated`, "i"),
    );
    expect(sql).not.toMatch(
      new RegExp(`REVOKE ALL ON FUNCTION ${SIG} FROM service_role`, "i"),
    );
    expect(sql).toMatch(
      new RegExp(`GRANT EXECUTE ON FUNCTION ${SIG} TO service_role`, "i"),
    );
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION .* TO authenticated/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/TO anon/i);
    expect(rb).not.toMatch(/TO PUBLIC/i);
    expect(rb).toMatch(
      new RegExp(`GRANT EXECUTE ON FUNCTION ${SIG} TO authenticated`, "i"),
    );
    expect(rb).toMatch(
      new RegExp(`GRANT EXECUTE ON FUNCTION ${SIG} TO service_role`, "i"),
    );
    expect(rb).not.toMatch(/PERFORM public\.promote_stacked_trip/i);
  });

  it("locks service-role Edge caller contract for promote_stacked_trip", () => {
    const lifecycle = read("supabase/functions/_shared/stackedRideLifecycle.ts");
    const stop = read("supabase/functions/stop-workflow/index.ts");
    const noShow = read("supabase/functions/pickup-no-show/index.ts");
    const cancel = read("supabase/functions/driver-cancel-before-pickup/index.ts");

    expect(lifecycle).toMatch(/rpc\("promote_stacked_trip"/);
    expect(lifecycle).toMatch(/p_driver_id:\s*driverId/);
    expect(lifecycle).toMatch(/p_completed_trip_id:\s*(currentTripId|completedTripId)/);

    expect(stop).toMatch(/createClient\(supabaseUrl,\s*serviceRoleKey\)/);
    expect(stop).toMatch(/tryPromoteStackedTripAfterCompletion/);
    expect(stop).toMatch(/requireAuthenticatedUser/);
    expect(stop).toMatch(/ignoredBodyDriverId/);

    expect(noShow).toMatch(/createClient\(supabaseUrl,\s*serviceRoleKey\)/);
    expect(noShow).toMatch(/handleQueuedTripAfterCurrentTripFailure/);
    expect(noShow).toMatch(/requireAuthenticatedUser/);

    expect(cancel).toMatch(/createClient\(supabaseUrl,\s*supabaseServiceKey\)/);
    expect(cancel).toMatch(/handleQueuedTripAfterCurrentTripFailure/);
  });
});
