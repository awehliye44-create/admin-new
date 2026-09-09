/**
 * Lock: Phase A8B4 apply_customer_decline_grace EXECUTE ACL draft + caller contract.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "../../..");
const CANONICAL =
  "supabase/migrations/20261109150000_phase_a8b4_apply_customer_decline_grace_execute_lock.sql";
const ROLLBACK =
  "supabase/migrations/rollback/rollback_20261109150000_phase_a8b4_apply_customer_decline_grace_execute_lock.sql";
const SIG = "public\\.apply_customer_decline_grace\\(uuid, text\\)";

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("phaseA8B4ApplyCustomerDeclineGraceExecuteLock", () => {
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
    expect(rb).not.toMatch(/PERFORM public\.apply_customer_decline_grace/i);
  });

  it("locks service-role Edge callers with ownership before RPC", () => {
    const grace = read("supabase/functions/_shared/customerNegotiationGrace.ts");
    const decision = read("supabase/functions/customer-fare-decision/index.ts");
    const expire = read("supabase/functions/expire-offers/index.ts");

    expect(grace).toMatch(/rpc\("apply_customer_decline_grace"/);
    expect(grace).toMatch(/p_offer_id:\s*params\.offer_id/);
    expect(grace).toMatch(/p_reason:\s*params\.reason/);

    expect(decision).toMatch(/createClient\(supabaseUrl,\s*supabaseServiceKey\)/);
    expect(decision).toMatch(/userClient\.auth\.getUser/);
    expect(decision).toMatch(/trip\.passenger_id === user\.id/);
    expect(decision).toMatch(/Not your trip/);
    expect(decision).toMatch(/enterDriverSecondChanceAtOriginalFare\(supabase/);

    expect(expire).toMatch(/createClient\(supabaseUrl,\s*supabaseKey\)/);
    expect(expire).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(expire).toMatch(/enterDriverSecondChanceAtOriginalFare\(supabase/);
    expect(expire).toMatch(/reason:\s*"timeout_customer"/);
  });
});
