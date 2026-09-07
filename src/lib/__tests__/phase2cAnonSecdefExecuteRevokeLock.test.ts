/**
 * Lock: Phase 2C EXECUTE revoke on final anon-executable signup catalogue SECDEF RPCs.
 *
 * If this fails, fix the migration / Driver Edge path — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');
const CANONICAL =
  'supabase/migrations/20261107150000_phase2c_anon_secdef_execute_revoke_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261107150000_phase2c_anon_secdef_execute_revoke_lock.sql';
const EDGE = 'supabase/functions/driver-signup-location-options/index.ts';

const LOCKED: { name: string; args: string }[] = [
  {
    name: 'get_driver_signup_location_options',
    args: 'double precision, double precision, text',
  },
  { name: 'get_driver_signup_service_areas', args: 'uuid' },
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function listSqlMigrations(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function revokeRolePattern(name: string, args: string, role: string): RegExp {
  const argRe = args.replace(/,/g, '\\s*,\\s*');
  const sig = String.raw`public\.${name}\s*\(\s*${argRe}\s*\)`;
  return new RegExp(
    String.raw`REVOKE\s+ALL\s+ON\s+FUNCTION\s+${sig}\s+FROM\s+${role}`,
    'i',
  );
}

describe('phase2cAnonSecdefExecuteRevokeLock', () => {
  it('canonical migration revokes PUBLIC+anon+authenticated; grants service_role only', () => {
    const sql = read(CANONICAL);
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(sql).not.toMatch(/cron\.(schedule|unschedule)/i);
    expect(sql).not.toMatch(/CREATE\s+TRIGGER/i);
    expect(sql).not.toMatch(/ALTER\s+POLICY|ENABLE\s+ROW\s+LEVEL/i);

    for (const fn of LOCKED) {
      expect(sql).toMatch(revokeRolePattern(fn.name, fn.args, 'PUBLIC'));
      expect(sql).toMatch(revokeRolePattern(fn.name, fn.args, 'anon'));
      expect(sql).toMatch(revokeRolePattern(fn.name, fn.args, 'authenticated'));
      expect(sql).toMatch(
        new RegExp(
          String.raw`GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.${fn.name}\s*\([^)]+\)\s+TO\s+service_role`,
          'i',
        ),
      );
      expect(sql).not.toMatch(
        new RegExp(
          String.raw`GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.${fn.name}\s*\([^)]+\)\s+TO\s+(anon|authenticated|PUBLIC)`,
          'i',
        ),
      );
    }
  });

  it('Edge wrapper still calls both RPCs with service_role client', () => {
    const edge = read(EDGE);
    expect(edge).toMatch(/get_driver_signup_location_options/);
    expect(edge).toMatch(/get_driver_signup_service_areas/);
    expect(edge).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(edge).toMatch(/sanitizeRegion|sanitizeServiceArea/);
  });

  it('no later migration re-grants PUBLIC/anon EXECUTE on locked functions', () => {
    const canonicalName = path.basename(CANONICAL);
    for (const file of listSqlMigrations()) {
      if (file <= canonicalName) continue;
      const body = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      for (const fn of LOCKED) {
        const grantRe = new RegExp(
          String.raw`GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.${fn.name}\s*\([^)]*\)\s+TO\s+([^;]+)`,
          'gi',
        );
        const matches = body.match(grantRe) ?? [];
        for (const g of matches) {
          expect(g).not.toMatch(/\bPUBLIC\b/i);
          expect(g).not.toMatch(/\banon\b/i);
        }
      }
    }
  });

  it('emergency rollback restores anon+authenticated+service_role EXECUTE', () => {
    const rb = read(ROLLBACK);
    expect(fs.existsSync(path.join(ROOT, CANONICAL))).toBe(true);
    expect(rb).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.get_driver_signup_location_options\s*\([^)]+\)\s+TO\s+anon/i,
    );
    expect(rb).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.get_driver_signup_service_areas\s*\(\s*uuid\s*\)\s+TO\s+anon/i,
    );
    expect(rb).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.get_driver_signup_location_options\s*\([^)]+\)\s+TO\s+authenticated/i,
    );
    expect(rb).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.get_driver_signup_service_areas\s*\(\s*uuid\s*\)\s+TO\s+service_role/i,
    );
  });
});
