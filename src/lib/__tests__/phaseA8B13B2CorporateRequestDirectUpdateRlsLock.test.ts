/**
 * @vitest-environment node
 *
 * Lock: Phase A8B13B2 closes authenticated direct UPDATE/DELETE on
 * corporate_account_requests by replacing Admin ALL with SELECT-only.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const SQL =
  'supabase/migrations/20261109270000_phase_a8b13b2_corporate_request_direct_update_rls_lock.sql';
const RB =
  'supabase/migrations/rollback/rollback_20261109270000_phase_a8b13b2_corporate_request_direct_update_rls_lock.sql';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phaseA8B13B2CorporateRequestDirectUpdateRlsLock', () => {
  it('drops Admin ALL and creates Admin SELECT-only; preserves applicant policies', () => {
    const sql = read(SQL);
    const rb = read(RB);

    expect(sql).toMatch(/Applied: canonical version 20261109270000/i);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "Admins can manage account requests"/);
    expect(sql).toMatch(/CREATE POLICY "Admins can select account requests"/);
    expect(sql).toMatch(/FOR SELECT/);
    expect(sql).toMatch(/has_role\(auth\.uid\(\),\s*'admin'::app_role\)/);
    expect(sql).not.toMatch(/FOR ALL/);
    expect(sql).not.toMatch(/FOR UPDATE/);
    expect(sql).not.toMatch(/FOR DELETE/);
    expect(sql).not.toMatch(/CREATE POLICY ".*applicant.*UPDATE/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/approve_corporate_request|reject_corporate_request|suspend_corporate_request/);
    expect(sql).not.toMatch(/Authenticated users can submit own account requests/);
    expect(sql).not.toMatch(/Users can view own requests/);

    expect(rb).toMatch(/DROP POLICY IF EXISTS "Admins can select account requests"/);
    expect(rb).toMatch(/CREATE POLICY "Admins can manage account requests"/);
    expect(rb).toMatch(/FOR ALL/);
    expect(rb).toMatch(/has_role\(auth\.uid\(\),\s*'admin'::app_role\)/);
  });
});
