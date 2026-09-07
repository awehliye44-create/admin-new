/**
 * Lock: Phase 2B EXECUTE revoke on remaining anon-executable SECURITY DEFINER fns.
 *
 * If this fails, fix the migration / callers — never delete or soften the lock.
 *
 * Protects against:
 *   - re-GRANT EXECUTE to PUBLIC/anon on the 12 locked functions
 *   - accidentally revoking anon on the two BLOCKER signup catalogue RPCs
 *     (pre-auth Driver Create Account still calls them via anon key)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');
const CANONICAL =
  'supabase/migrations/20261107140000_phase2b_anon_secdef_execute_revoke_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261107140000_phase2b_anon_secdef_execute_revoke_lock.sql';

const LOCKED: { name: string; args: string }[] = [
  { name: 'admin_decide_customer_identity', args: 'uuid, text, text, text, text' },
  { name: 'admin_unlock_customer_name_edit', args: 'uuid' },
  {
    name: 'finalize_driver_onboarding_registration',
    args: 'text, text, text, text, text, text, uuid, uuid[], text, text, integer, text, text, text',
  },
  { name: 'get_customer_identity_verification_gate', args: 'uuid' },
  { name: 'staff_has_company_funds_read_access', args: 'text' },
  { name: 'sync_current_driver_document_approval', args: '' },
  { name: 'drivers_on_auth_detach', args: '' },
  { name: 'drivers_release_vehicles_on_soft_delete', args: '' },
  { name: 'enforce_driver_privileged_column_guard', args: '' },
  { name: 'list_driver_signup_countries', args: '' },
  { name: 'list_enabled_otp_country_codes', args: '' },
  { name: 'validate_driver_signup_region_service_areas', args: 'uuid, uuid[]' },
];

const BLOCKERS = [
  'get_driver_signup_location_options',
  'get_driver_signup_service_areas',
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

function revokePublicPattern(name: string, args: string): RegExp {
  const argRe = args
    ? args.replace(/,/g, '\\s*,\\s*').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
    : '';
  const sig = argRe
    ? String.raw`public\.${name}\s*\(\s*${argRe}\s*\)`
    : String.raw`public\.${name}\s*\(\s*\)`;
  return new RegExp(String.raw`REVOKE\s+ALL\s+ON\s+FUNCTION\s+${sig}\s+FROM\s+PUBLIC`, 'i');
}

function revokeAnonPattern(name: string, args: string): RegExp {
  const argRe = args
    ? args.replace(/,/g, '\\s*,\\s*').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
    : '';
  const sig = argRe
    ? String.raw`public\.${name}\s*\(\s*${argRe}\s*\)`
    : String.raw`public\.${name}\s*\(\s*\)`;
  return new RegExp(String.raw`REVOKE\s+ALL\s+ON\s+FUNCTION\s+${sig}\s+FROM\s+anon`, 'i');
}

describe('phase2bAnonSecdefExecuteRevokeLock', () => {
  it('canonical migration revokes PUBLIC+anon on all 12 locked signatures', () => {
    const sql = read(CANONICAL);
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(sql).not.toMatch(/cron\.(schedule|unschedule)/i);
    expect(sql).not.toMatch(/CREATE\s+TRIGGER/i);
    expect(sql).not.toMatch(/ALTER\s+POLICY|ENABLE\s+ROW\s+LEVEL/i);

    for (const fn of LOCKED) {
      expect(sql).toMatch(revokePublicPattern(fn.name, fn.args));
      expect(sql).toMatch(revokeAnonPattern(fn.name, fn.args));
    }
  });

  it('does not revoke anon on blocker signup catalogue RPCs', () => {
    const sql = read(CANONICAL);
    for (const name of BLOCKERS) {
      expect(sql).not.toMatch(
        new RegExp(String.raw`REVOKE[\s\S]{0,80}${name}[\s\S]{0,80}FROM\s+anon`, 'i'),
      );
    }
    expect(sql).toMatch(/BLOCKER/i);
    expect(sql).toMatch(/get_driver_signup_location_options/);
    expect(sql).toMatch(/get_driver_signup_service_areas/);
  });

  it('keeps authenticated EXECUTE on admin/post-auth/RLS helpers; strips client roles from triggers', () => {
    const sql = read(CANONICAL);
    expect(sql).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.admin_decide_customer_identity\s*\([^)]+\)\s+TO\s+authenticated/i,
    );
    expect(sql).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.finalize_driver_onboarding_registration\s*\([^)]+\)\s+TO\s+authenticated/i,
    );
    expect(sql).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.get_customer_identity_verification_gate\s*\(\s*uuid\s*\)\s+TO\s+authenticated/i,
    );
    expect(sql).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.sync_current_driver_document_approval\s*\(\s*\)\s+TO\s+authenticated/i,
    );
    expect(sql).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.staff_has_company_funds_read_access\s*\(\s*text\s*\)\s+TO\s+authenticated/i,
    );

    for (const name of [
      'drivers_on_auth_detach',
      'drivers_release_vehicles_on_soft_delete',
      'enforce_driver_privileged_column_guard',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          String.raw`REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.${name}\s*\(\s*\)\s+FROM\s+authenticated`,
          'i',
        ),
      );
      expect(sql).not.toMatch(
        new RegExp(
          String.raw`GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.${name}\s*\(\s*\)\s+TO\s+(anon|authenticated|service_role|PUBLIC)`,
          'i',
        ),
      );
    }
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

  it('emergency rollback restores anon EXECUTE on locked functions and exists beside forward migration', () => {
    const rb = read(ROLLBACK);
    expect(fs.existsSync(path.join(ROOT, CANONICAL))).toBe(true);
    expect(rb).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.admin_decide_customer_identity\s*\([^)]+\)\s+TO\s+anon/i,
    );
    expect(rb).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.drivers_on_auth_detach\s*\(\s*\)\s+TO\s+PUBLIC/i,
    );
  });
});
