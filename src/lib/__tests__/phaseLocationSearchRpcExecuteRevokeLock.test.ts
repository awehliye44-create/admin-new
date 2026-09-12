/**
 * Lock: ACL revoke for location-search SECURITY DEFINER helpers.
 *
 * If this fails, fix the migration — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261112150000_phase_location_search_rpc_execute_revoke.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261112150000_phase_location_search_rpc_execute_revoke.sql';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phaseLocationSearchRpcExecuteRevokeLock', () => {
  it('revokes client execute and keeps service_role on both location RPCs', () => {
    const sql = read(CANONICAL);
    expect(sql).not.toMatch(/DRAFT \/ NOT APPLIED/);
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(sql).not.toMatch(/ALTER\s+FUNCTION/i);

    expect(sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.search_places\s*\(\s*text\s*,\s*uuid\s*,\s*integer\s*\)\s+FROM\s+PUBLIC/i,
    );
    expect(sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.search_places\s*\(\s*text\s*,\s*uuid\s*,\s*integer\s*\)\s+FROM\s+anon/i,
    );
    expect(sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.search_places\s*\(\s*text\s*,\s*uuid\s*,\s*integer\s*\)\s+FROM\s+authenticated/i,
    );
    expect(sql).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.search_places\s*\(\s*text\s*,\s*uuid\s*,\s*integer\s*\)\s+TO\s+service_role/i,
    );
    expect(sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.search_onecab_location_landmarks\s*\(\s*text\s*,\s*uuid\s*,\s*text\s*,\s*uuid\s*,\s*integer\s*\)\s+FROM\s+PUBLIC/i,
    );
    expect(sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.search_onecab_location_landmarks\s*\(\s*text\s*,\s*uuid\s*,\s*text\s*,\s*uuid\s*,\s*integer\s*\)\s+FROM\s+anon/i,
    );
    expect(sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.search_onecab_location_landmarks\s*\(\s*text\s*,\s*uuid\s*,\s*text\s*,\s*uuid\s*,\s*integer\s*\)\s+FROM\s+authenticated/i,
    );
    expect(sql).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.search_onecab_location_landmarks\s*\(\s*text\s*,\s*uuid\s*,\s*text\s*,\s*uuid\s*,\s*integer\s*\)\s+TO\s+service_role/i,
    );
    expect(sql).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.search_places\s*\([^)]*\)\s+TO\s+authenticated/i,
    );
    expect(sql).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.search_onecab_location_landmarks\s*\([^)]*\)\s+TO\s+authenticated/i,
    );
  });

  it('rollback restores authenticated execute and does not rewrite bodies', () => {
    const rb = read(ROLLBACK);
    expect(rb).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(rb).toMatch(/search_places\(text, uuid, integer\)\s+TO\s+authenticated/i);
    expect(rb).toMatch(/search_places\(text, uuid, integer\)\s+TO\s+service_role/i);
    expect(rb).toMatch(
      /search_onecab_location_landmarks\(text, uuid, text, uuid, integer\)\s+TO\s+authenticated/i,
    );
    expect(rb).toMatch(
      /search_onecab_location_landmarks\(text, uuid, text, uuid, integer\)\s+TO\s+service_role/i,
    );
  });
});
