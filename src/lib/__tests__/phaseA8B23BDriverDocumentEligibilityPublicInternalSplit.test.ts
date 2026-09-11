/**
 * Lock: Phase A8B23B document eligibility public/internal split draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109380000_phase_a8b23b_driver_document_eligibility_public_internal_split.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109380000_phase_a8b23b_driver_document_eligibility_public_internal_split.sql';
const VERIFY =
  'supabase/tests/phase_a8b23b_driver_document_eligibility_public_internal_split_verify.sql';

const BASELINE_PUBLIC = '55d576d83a424beb3de3c79a4cf629d4';
const PROPOSED_PUBLIC = 'dab246830972a37c6351767322b0f66d';
const PROPOSED_CHECK = 'c19c0eeb8b08eb136aed6683937ccd0e';
const PROPOSED_ASSERT = '189b842f514da1f2e484fd459df788f2';
const PROPOSED_ACCEPT = '5187523904390ffed251558534bc1bc6';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phaseA8B23BDriverDocumentEligibilityPublicInternalSplit', () => {
  it('clones computation internally, self-binds the public RPC, and rewires only direct parents', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    const verify = read(VERIFY);

    expect(sql).toMatch(/Applied to ACTIVE_HEALTHY/i);
    expect(sql).toMatch(/get_driver_document_eligibility_internal/);
    expect(sql).toMatch(/d\.user_id = auth\.uid\(\)/);
    expect(sql).toMatch(/ERRCODE = '42501'/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.get_driver_document_eligibility_internal\(uuid\) FROM authenticated/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.get_driver_document_eligibility\(uuid\) FROM service_role/i);
    expect(sql).toMatch(/check_driver_documents_approved/);
    expect(sql).toMatch(/assert_driver_presence_online_eligible/);
    expect(sql).toMatch(/accept_ride_offer_eligibility_guard/);
    expect(sql).not.toMatch(/current_user/);
    expect(sql).not.toMatch(/profiles\.role/);
    expect(sql).not.toMatch(/raw_user_meta_data/);
    expect(sql).not.toMatch(/GRANT EXECUTE.*TO (PUBLIC|anon)/i);
    expect(sql).toContain(BASELINE_PUBLIC);
    expect(sql).toContain(PROPOSED_PUBLIC);
    expect(sql).toContain(PROPOSED_CHECK);
    expect(sql).toContain(PROPOSED_ASSERT);
    expect(sql).toContain(PROPOSED_ACCEPT);

    expect(rb).toMatch(/DROP FUNCTION IF EXISTS public\.get_driver_document_eligibility_internal/);
    expect(rb).toContain(BASELINE_PUBLIC);
    expect(rb).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_driver_document_eligibility\(uuid\) TO service_role/i);
    expect(rb).not.toMatch(/GRANT EXECUTE.*TO (PUBLIC|anon)/i);

    expect(verify).toMatch(/A8B23B_SIM_OK/);
    expect(verify).toContain(PROPOSED_PUBLIC);
    expect(verify).toContain(BASELINE_PUBLIC);
  });
});
