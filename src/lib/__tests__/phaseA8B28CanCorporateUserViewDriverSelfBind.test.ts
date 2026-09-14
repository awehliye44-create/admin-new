/**
 * Lock: Phase A8B28 can_corporate_user_view_driver self-bind.
 * If this fails, fix the draft — never delete or soften the lock.
 *
 * Hash convention: proposed/baseline body MD5 = md5(pg_proc.prosrc).
 * md5(pg_get_functiondef) for the same proposed body is FUNCTIONDEF_MD5.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109420000_phase_a8b28_can_corporate_user_view_driver_self_bind.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109420000_phase_a8b28_can_corporate_user_view_driver_self_bind.sql';
const VERIFY =
  'supabase/tests/phase_a8b28_can_corporate_user_view_driver_self_bind_verify.sql';

const BASELINE_MD5 = 'b000bb084232102300009c2a03d9bcb0';
const PROPOSED_MD5 = '80c738f1ab36c17174bcc98a8416855c';
const FUNCTIONDEF_MD5 = '8e44e4fb68513a01b747882b3acce69e';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phaseA8B28CanCorporateUserViewDriverSelfBind', () => {
  it('self-binds p_user_id to auth.uid and restores the exact production body', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    const verify = read(VERIFY);

    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.can_corporate_user_view_driver\(p_driver_id uuid, p_user_id uuid\)/,
    );
    expect(sql).toMatch(/auth\.uid\(\) IS NOT NULL/);
    expect(sql).toMatch(/p_user_id IS NOT DISTINCT FROM auth\.uid\(\)/);
    expect(sql).toMatch(/FROM trips t/);
    expect(sql).toMatch(/corporate_user_accounts cua/);
    expect(sql).toMatch(/drivers_public_safe/);
    expect(sql).toMatch(/md5\(pg_proc\.prosrc\)/);
    expect(sql).toContain(BASELINE_MD5);
    expect(sql).toContain(PROPOSED_MD5);
    expect(sql).toContain(FUNCTIONDEF_MD5);
    expect(sql).toMatch(/unchanged 111/);

    const fnStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.can_corporate_user_view_driver',
    );
    const fnBodyStart = sql.indexOf('$function$', fnStart);
    const fnBodyEnd = sql.indexOf('$function$;', fnBodyStart + 10);
    const fnBody = sql.slice(fnBodyStart, fnBodyEnd);
    expect(fnBody).not.toMatch(/current_user/);
    expect(fnBody).not.toMatch(/profiles\.role/);
    expect(fnBody).not.toMatch(/raw_user_meta_data/);
    expect(fnBody).not.toMatch(/auth\.role\(\)\s*=\s*'service_role'/);
    expect(fnBody).not.toMatch(/\bRAISE\b/);
    expect(sql).not.toMatch(/GRANT EXECUTE.*TO (PUBLIC|anon)/i);
    expect(sql).not.toMatch(/REVOKE\b/i);

    expect(rb).toMatch(
      /CREATE OR REPLACE FUNCTION public\.can_corporate_user_view_driver\(p_driver_id uuid, p_user_id uuid\)/,
    );
    expect(rb).toMatch(/SELECT EXISTS \(/);
    expect(rb).not.toMatch(/auth\.uid\(\)/);
    expect(rb).toContain(BASELINE_MD5);
    expect(rb).not.toMatch(/GRANT EXECUTE.*TO (PUBLIC|anon)/i);

    expect(verify).toMatch(/A8B28_SIM_OK/);
    expect(verify).toMatch(/ROLLBACK;/);
    expect(verify).toContain(PROPOSED_MD5);
    expect(verify).toContain(BASELINE_MD5);
    expect(verify).toMatch(/drivers_public_safe/);
    expect(verify).toMatch(/foreign user_id expected false/);
    expect(verify).not.toMatch(/PERFORM net\.http_post/);
  });
});
