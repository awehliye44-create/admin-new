/**
 * Lock: Phase A7C1 corporate helper self-bind draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "../../..");
const CANONICAL = "supabase/migrations/20261109080000_phase_a7c1_corporate_helper_self_bind.sql";
const ROLLBACK = "supabase/migrations/rollback/rollback_20261109080000_phase_a7c1_corporate_helper_self_bind.sql";

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("phaseA7C1CorporateHelperSelfBind", () => {
  it("self-binds both helpers and restores the captured bodies", () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);

    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.has_corporate_access\(p_user_id uuid, p_corporate_account_id uuid\)/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.can_write_corporate\(p_user_id uuid, p_corporate_account_id uuid\)/);
    expect(sql).toMatch(/auth\.uid\(\) IS NOT NULL/);
    expect(sql).toMatch(/p_user_id IS NOT DISTINCT FROM auth\.uid\(\)/);
    expect(sql).toMatch(/cua\.role IN \('admin', 'manager'\)/);
    expect(sql).not.toMatch(/cua\.role IN \('admin', 'manager', 'owner'\)/);
    expect(sql).not.toMatch(/\bRAISE\b/i);
    expect(sql).not.toMatch(/\bGRANT\b/i);
    expect(sql).not.toMatch(/\bREVOKE\b/i);
    expect(sql).not.toMatch(/\bcurrent_user\b/i);
    expect(sql).not.toMatch(/auth\.role\(\)\s*=\s*'service_role'/);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.has_role/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.is_owner/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.update_corporate_account_profile/i);

    expect(rb).toMatch(/CREATE OR REPLACE FUNCTION public\.has_corporate_access\(p_user_id uuid, p_corporate_account_id uuid\)/);
    expect(rb).toMatch(/CREATE OR REPLACE FUNCTION public\.can_write_corporate\(p_user_id uuid, p_corporate_account_id uuid\)/);
    expect(rb).toMatch(/WHERE user_id = p_user_id/);
    expect(rb).toMatch(/cua\.role IN \('admin', 'manager'\)/);
    expect(rb).not.toMatch(/auth\.uid\(\)/);
    expect(rb).not.toMatch(/\bGRANT\b/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/CREATE OR REPLACE FUNCTION public\.has_role/i);
  });
});
