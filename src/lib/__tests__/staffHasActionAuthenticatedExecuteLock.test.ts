/**
 * Lock: staff_has_action must remain executable by authenticated.
 * Demand-zone (and other Admin) RLS policies invoke it as the invoker.
 * If this fails, fix the restore migration — never re-revoke authenticated EXECUTE.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const RESTORE =
  'supabase/migrations/20261224140000_staff_has_action_authenticated_execute_restore.sql';

describe('staffHasActionAuthenticatedExecuteLock', () => {
  it('restores authenticated EXECUTE and keeps anon/PUBLIC revoked', () => {
    const sql = fs.readFileSync(path.join(ROOT, RESTORE), 'utf8');
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.staff_has_action\(uuid,\s*text\) TO authenticated/i,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.staff_has_action\(uuid,\s*text\) TO service_role/i,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.staff_has_action\(uuid,\s*text\) FROM PUBLIC/i,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.staff_has_action\(uuid,\s*text\) FROM anon/i,
    );
    expect(sql).not.toMatch(
      /REVOKE ALL ON FUNCTION public\.staff_has_action\(uuid,\s*text\) FROM authenticated/i,
    );
    expect(sql).toMatch(/demand_zones/i);
    expect(sql).toMatch(/42501/);
  });
});
