/**
 * Lock: CERTIFICATION_NON_PAYABLE repair RPC EXECUTE hardening follow-up.
 * Source must reproduce service_role-only ACL (PUBLIC + anon + authenticated revoked).
 * If this fails, fix the migration — never delete or soften the lock.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "../../..");
const CANONICAL =
  "supabase/migrations/20261201130000_certification_non_payable_repair_execute_lock.sql";
const ROLLBACK =
  "supabase/migrations/rollback/rollback_20261201130000_certification_non_payable_repair_execute_lock.sql";

const SIG =
  "public.admin_apply_certification_non_payable_repair\\(\\s*uuid, uuid, uuid, uuid, text, text, text, uuid, uuid, jsonb, text\\s*\\)";

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("certificationNonPayableRepairExecuteLock", () => {
  it("revokes PUBLIC+anon+authenticated and grants service_role only; rollback never restores insecure grants", () => {
    const sql = read(CANONICAL).replace(/\s+/g, " ").trim();
    const rb = read(ROLLBACK);

    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/ALTER DEFAULT PRIVILEGES/i);
    expect(sql).not.toMatch(/ UPDATE /i);
    expect(sql).not.toMatch(/ INSERT /i);
    expect(sql).not.toMatch(/ DELETE /i);

    expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${SIG} FROM PUBLIC`, "i"));
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${SIG} FROM anon`, "i"));
    expect(sql).toMatch(
      new RegExp(`REVOKE ALL ON FUNCTION ${SIG} FROM authenticated`, "i"),
    );
    expect(sql).toMatch(
      new RegExp(`GRANT EXECUTE ON FUNCTION ${SIG} TO service_role`, "i"),
    );

    expect(rb).not.toMatch(/^\s*GRANT\s+EXECUTE\b/im);
    expect(rb).not.toMatch(/^\s*GRANT\s+ALL\b/im);
    expect(rb).not.toMatch(
      /GRANT EXECUTE ON FUNCTION[\s\S]*TO\s+(anon|authenticated|PUBLIC)\b/i,
    );
  });
});
