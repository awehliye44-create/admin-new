/**
 * Lock: Phase A7C2A is_super_admin session-bind draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "../../..");
const CANONICAL = "supabase/migrations/20261109090000_phase_a7c2a_is_super_admin_self_bind.sql";
const ROLLBACK = "supabase/migrations/rollback/rollback_20261109090000_phase_a7c2a_is_super_admin_self_bind.sql";

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("phaseA7C2AIsSuperAdminSelfBind", () => {
  it("self-binds is_super_admin and restores the captured body", () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);

    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.is_super_admin\(_user_id uuid\)/);
    expect(sql).toMatch(/auth\.uid\(\) IS NOT NULL/);
    expect(sql).toMatch(/_user_id IS NOT DISTINCT FROM auth\.uid\(\)/);
    expect(sql).toMatch(/public\.is_owner\(_user_id\)/);
    expect(sql).toMatch(/sp\.role = 'super_admin'/);
    expect(sql).toMatch(/public\.has_role\(_user_id, 'admin'::public\.app_role\)/);
    expect(sql).not.toMatch(/\bRAISE\b/i);
    expect(sql).not.toMatch(/\bGRANT\b/i);
    expect(sql).not.toMatch(/\bREVOKE\b/i);
    expect(sql).not.toMatch(/\bcurrent_user\b/i);
    expect(sql).not.toMatch(/auth\.role\(\)\s*=\s*'service_role'/);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.has_role/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.staff_has_action/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.is_owner/i);

    expect(rb).toMatch(/CREATE OR REPLACE FUNCTION public\.is_super_admin\(_user_id uuid\)/);
    expect(rb).toMatch(/public\.is_owner\(_user_id\)/);
    expect(rb).toMatch(/public\.has_role\(_user_id, 'admin'::public\.app_role\)/);
    expect(rb).not.toMatch(/auth\.uid\(\)/);
    expect(rb).not.toMatch(/\bGRANT\b/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/CREATE OR REPLACE FUNCTION public\.has_role/i);
  });
});
