/**
 * @vitest-environment node
 * Lock: Phase A7C2C has_role session-bind draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "../../..");
const CANONICAL =
  "supabase/migrations/20261109100000_phase_a7c2c_has_role_self_bind.sql";
const ROLLBACK =
  "supabase/migrations/rollback/rollback_20261109100000_phase_a7c2c_has_role_self_bind.sql";
const VERIFY = "supabase/tests/phase_a7c2c_has_role_self_bind_verify.sql";
const EDGE_AUTH = "supabase/functions/_shared/adminEmergencyDispatchAuth.ts";
const EDGE_INDEX = "supabase/functions/admin-emergency-dispatch/index.ts";

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("phaseA7C2CHasRoleSelfBind", () => {
  it("self-binds has_role and restores the captured production body", () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    const verify = read(VERIFY);

    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.has_role\(_user_id uuid, _role app_role\)/,
    );
    expect(sql).toMatch(/auth\.uid\(\) IS NOT NULL/);
    expect(sql).toMatch(/_user_id IS NOT DISTINCT FROM auth\.uid\(\)/);
    expect(sql).toMatch(/FROM public\.user_roles/);
    expect(sql).toMatch(/user_roles\.role = _role/);
    expect(sql).not.toMatch(/\bRAISE\b/i);
    expect(sql).not.toMatch(/\bGRANT\b/i);
    expect(sql).not.toMatch(/\bREVOKE\b/i);
    expect(sql).not.toMatch(/\bcurrent_user\b/i);
    expect(sql).not.toMatch(/auth\.role\(\)\s*=\s*'service_role'/);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.is_super_admin/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.staff_has_action/i);

    expect(rb).toMatch(
      /CREATE OR REPLACE FUNCTION public\.has_role\(_user_id uuid, _role app_role\)/,
    );
    expect(rb).toMatch(/FROM public\.user_roles/);
    expect(rb).not.toMatch(/auth\.uid\(\)/);
    expect(rb).not.toMatch(/\bGRANT\b/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);

    expect(verify).toMatch(/ROLLBACK;/);
    expect(verify).toMatch(/2ff1ba77ea1446501c56062a519ecd56/);
    expect(verify).toMatch(/authenticated SECURITY DEFINER 202/);
  });

  it("keeps admin-emergency-dispatch on the user-scoped has_role path", () => {
    const auth = read(EDGE_AUTH);
    const index = read(EDGE_INDEX);

    expect(auth).toMatch(/auth\.getUser\(token\)/);
    expect(auth).toMatch(/userClient\.rpc\("has_role"/);
    expect(auth).toMatch(/_user_id: actorUserId/);
    expect(auth).not.toMatch(/SERVICE_ROLE/);
    expect(index).toMatch(/authorizeAdminEmergencyDispatch/);
    expect(index).toMatch(/if \(req\.method === "OPTIONS"\) return handleCORSPreflight\(\)/);
    expect(index.indexOf("authorizeAdminEmergencyDispatch")).toBeLessThan(
      index.indexOf("createClient(supabaseUrl, serviceRoleKey)"),
    );
  });
});
