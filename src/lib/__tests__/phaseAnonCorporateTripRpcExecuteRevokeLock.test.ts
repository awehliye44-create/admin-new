/**
 * Lock: PUBLIC/anon EXECUTE revoke on the two corporate-trip SECDEF RPCs.
 *
 * If this fails, fix the migration — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');
const CANONICAL =
  'supabase/migrations/20261112130000_phase_anon_corporate_trip_rpc_execute_revoke.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261112130000_phase_anon_corporate_trip_rpc_execute_revoke.sql';

const LOCKED = [
  'activate_paid_corporate_trip',
  'discard_unpaid_corporate_trip',
] as const;

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function listSqlMigrations(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

describe('phaseAnonCorporateTripRpcExecuteRevokeLock', () => {
  it('revokes PUBLIC and anon only, and keeps authenticated plus service_role', () => {
    const sql = read(CANONICAL);
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(sql).not.toMatch(/ALTER\s+FUNCTION/i);
    expect(sql).not.toMatch(/cron\.(schedule|unschedule)/i);
    expect(sql).not.toMatch(/CREATE\s+TRIGGER/i);
    expect(sql).not.toMatch(/ALTER\s+POLICY|ENABLE\s+ROW\s+LEVEL/i);

    for (const name of LOCKED) {
      const sig = String.raw`public\.${name}\s*\(\s*uuid\s*\)`;
      expect(sql).toMatch(new RegExp(String.raw`REVOKE\s+ALL\s+ON\s+FUNCTION\s+${sig}\s+FROM\s+PUBLIC`, 'i'));
      expect(sql).toMatch(new RegExp(String.raw`REVOKE\s+ALL\s+ON\s+FUNCTION\s+${sig}\s+FROM\s+anon`, 'i'));
      expect(sql).not.toMatch(new RegExp(String.raw`REVOKE\s+ALL\s+ON\s+FUNCTION\s+${sig}\s+FROM\s+authenticated`, 'i'));
      expect(sql).not.toMatch(new RegExp(String.raw`REVOKE\s+ALL\s+ON\s+FUNCTION\s+${sig}\s+FROM\s+service_role`, 'i'));
      expect(sql).toMatch(new RegExp(String.raw`GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+${sig}\s+TO\s+authenticated`, 'i'));
      expect(sql).toMatch(new RegExp(String.raw`GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+${sig}\s+TO\s+service_role`, 'i'));
      expect(sql).not.toMatch(new RegExp(String.raw`GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+${sig}\s+TO\s+(anon|PUBLIC)`, 'i'));
    }
  });

  it('no later migration re-grants PUBLIC or anon EXECUTE', () => {
    const canonicalName = path.basename(CANONICAL);
    for (const file of listSqlMigrations()) {
      if (file <= canonicalName) continue;
      const body = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      for (const name of LOCKED) {
        const grantRe = new RegExp(
          String.raw`GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.${name}\s*\([^)]*\)\s+TO\s+([^;]+)`,
          'gi',
        );
        for (const grant of body.match(grantRe) ?? []) {
          expect(grant).not.toMatch(/\bPUBLIC\b/i);
          expect(grant).not.toMatch(/\banon\b/i);
        }
      }
    }
  });

  it('rollback restores PUBLIC and anon without rewriting function bodies', () => {
    const rb = read(ROLLBACK);
    expect(rb).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    for (const name of LOCKED) {
      const sig = String.raw`public\.${name}\s*\(\s*uuid\s*\)`;
      expect(rb).toMatch(new RegExp(String.raw`GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+${sig}\s+TO\s+PUBLIC`, 'i'));
      expect(rb).toMatch(new RegExp(String.raw`GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+${sig}\s+TO\s+anon`, 'i'));
      expect(rb).toMatch(new RegExp(String.raw`GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+${sig}\s+TO\s+authenticated`, 'i'));
      expect(rb).toMatch(new RegExp(String.raw`GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+${sig}\s+TO\s+service_role`, 'i'));
    }
  });
});
