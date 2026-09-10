/**
 * @vitest-environment node
 *
 * Lock: Phase A8B13B reject_corporate_request RPC + Admin caller.
 * If this fails, fix the draft — never delete or soften the lock.
 * A8B13B2 RLS closure is intentionally out of scope for this lock.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const RPC =
  'supabase/migrations/20261109260000_phase_a8b13b_reject_corporate_request_authz_lock.sql';
const RPC_RB =
  'supabase/migrations/rollback/rollback_20261109260000_phase_a8b13b_reject_corporate_request_authz_lock.sql';
const UI = 'src/pages/AccountRequests.tsx';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phaseA8B13BRejectCorporateRequestAuthzLock', () => {
  it('gates account-requests, stamps auth.uid, pending/under_review only', () => {
    const sql = read(RPC);
    const rb = read(RPC_RB);

    expect(sql).toMatch(/Applied: canonical version 20261109260000/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.reject_corporate_request/);
    expect(sql).toMatch(/staff_has_page_access\('account-requests'\)/);
    expect(sql).toMatch(/WHEN auth\.role\(\) = 'service_role' THEN COALESCE\(p_reviewed_by, auth\.uid\(\)\)/);
    expect(sql).toMatch(/ELSE auth\.uid\(\)/);
    expect(sql).toMatch(/SET status = 'rejected'/);
    expect(sql).toMatch(/under_review/);
    expect(sql).toMatch(/RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'Request not found'/);
    expect(sql).toMatch(/baaa27a6183d5b25e45ea83f3f0eaee7/);
    expect(sql).toMatch(/rejection reason too long/);
    expect(sql).not.toMatch(/INSERT INTO public\.corporate_accounts/i);
    expect(sql).not.toMatch(/current_user\s*=\s*'postgres'/);
    expect(sql).not.toMatch(/profiles\.role/);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.reject_corporate_request\(uuid, text, uuid\) TO authenticated/i,
    );
    expect(sql).not.toMatch(/GRANT EXECUTE.*TO (PUBLIC|anon)/i);
    expect(sql).not.toMatch(/DROP POLICY/i);

    expect(rb).toMatch(/DROP FUNCTION IF EXISTS public\.reject_corporate_request/);
  });

  it('Admin reject path calls reject_corporate_request RPC', () => {
    const ui = read(UI);
    expect(ui).toMatch(/reject_corporate_request/);
    expect(ui).toMatch(/approve_corporate_request/);
    expect(ui).toMatch(/suspend_corporate_request/);
    expect(ui).toMatch(/42501/);
    expect(ui).not.toMatch(/status:\s*'rejected'/);
    expect(ui).not.toMatch(/\.from\(['"]corporate_account_requests['"]\)[\s\S]{0,200}\.update\(/);
  });
});
