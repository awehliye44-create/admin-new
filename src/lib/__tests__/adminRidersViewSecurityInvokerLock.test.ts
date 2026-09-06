/**
 * Lock: public.admin_riders_with_trip_stats stays SECURITY INVOKER + admin-gated.
 *
 * If this fails, fix the migration / consumers — never delete or soften the lock.
 *
 * Protects against recreating the view without:
 *   - security_invoker = true
 *   - has_role(admin) OR auth.role() = service_role row gate
 *   - SELECT-only grants (no anon / PUBLIC)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');
const CANONICAL =
  'supabase/migrations/20261107120000_admin_riders_view_security_invoker_lock.sql';
const VIEW = 'admin_riders_with_trip_stats';

const REQUIRED_COLUMNS = [
  'id',
  'user_id',
  'customer_code',
  'first_name',
  'last_name',
  'phone',
  'email',
  'created_at',
  'updated_at',
  'rider_status',
  'email_verified',
  'phone_verified',
  'identity_verified_at',
  'identity_provider',
  'name_edit_locked',
  'name_unlocked_at',
  'trip_count',
  'last_trip_at',
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

/** Last migration (by filename) that creates/replaces the riders view. */
function latestViewTouchMigration(): { file: string; body: string } {
  const touches: { file: string; body: string }[] = [];
  for (const file of listSqlMigrations()) {
    const body = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    if (
      new RegExp(
        String.raw`create(?:\s+or\s+replace)?\s+view\s+public\.${VIEW}`,
        'i',
      ).test(body)
    ) {
      touches.push({ file, body });
    }
  }
  expect(touches.length).toBeGreaterThan(0);
  return touches[touches.length - 1]!;
}

describe('adminRidersViewSecurityInvokerLock', () => {
  it('canonical migration enforces invoker, admin gate, and SELECT-only grants', () => {
    const sql = read(CANONICAL);

    expect(sql).toMatch(/WITH\s*\(\s*security_invoker\s*=\s*true\s*\)/i);
    expect(sql).toMatch(/has_role\s*\(\s*auth\.uid\s*\(\s*\)\s*,\s*'admin'/i);
    expect(sql).toMatch(/auth\.role\s*\(\s*\)\s*=\s*'service_role'/i);

    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+TABLE\s+public\.admin_riders_with_trip_stats\s+FROM\s+PUBLIC/i);
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+TABLE\s+public\.admin_riders_with_trip_stats\s+FROM\s+anon/i);
    expect(sql).toMatch(
      /GRANT\s+SELECT\s+ON\s+TABLE\s+public\.admin_riders_with_trip_stats\s+TO\s+authenticated/i,
    );
    expect(sql).toMatch(
      /GRANT\s+SELECT\s+ON\s+TABLE\s+public\.admin_riders_with_trip_stats\s+TO\s+service_role/i,
    );

    // No DML grants to client roles in the canonical migration.
    expect(sql).not.toMatch(
      /GRANT\s+(ALL|INSERT|UPDATE|DELETE|TRUNCATE)\b[\s\S]{0,80}admin_riders_with_trip_stats[\s\S]{0,40}(anon|authenticated)/i,
    );

    for (const col of REQUIRED_COLUMNS) {
      expect(sql.toLowerCase()).toContain(col);
    }
  });

  it('chronologically last view CREATE keeps security_invoker + admin gate', () => {
    const { file, body } = latestViewTouchMigration();
    expect(file).toBe(path.basename(CANONICAL));
    expect(body).toMatch(/WITH\s*\(\s*security_invoker\s*=\s*true\s*\)/i);
    expect(body).toMatch(/has_role\s*\(\s*auth\.uid\s*\(\s*\)\s*,\s*'admin'/i);
    expect(body).toMatch(/auth\.role\s*\(\s*\)\s*=\s*'service_role'/i);
  });

  it('no later migration recreates the view without security_invoker', () => {
    const canonicalName = path.basename(CANONICAL);
    for (const file of listSqlMigrations()) {
      if (file <= canonicalName) continue;
      const body = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      if (
        !new RegExp(
          String.raw`create(?:\s+or\s+replace)?\s+view\s+public\.${VIEW}`,
          'i',
        ).test(body)
      ) {
        continue;
      }
      expect(body).toMatch(/WITH\s*\(\s*security_invoker\s*=\s*true\s*\)/i);
      expect(body).toMatch(/has_role\s*\(\s*auth\.uid\s*\(\s*\)\s*,\s*'admin'/i);
    }
  });

  it('Admin Riders page still reads the view with required columns — no frontend rewrite needed', () => {
    const riders = read('src/pages/Riders.tsx');
    expect(riders).toContain(`.from('${VIEW}')`);
    expect(riders).toContain('ADMIN_RIDERS_PAGE_SIZE');
    for (const col of [
      'id',
      'user_id',
      'customer_code',
      'first_name',
      'last_name',
      'phone',
      'email',
      'created_at',
      'updated_at',
      'rider_status',
      'trip_count',
      'last_trip_at',
      'identity_verified_at',
      'identity_provider',
      'name_edit_locked',
      'name_unlocked_at',
    ]) {
      expect(riders).toContain(col);
    }
  });

  it('generated types still expose the view with the same column set', () => {
    const types = read('src/integrations/supabase/types.ts');
    const idx = types.indexOf('admin_riders_with_trip_stats:');
    expect(idx).toBeGreaterThan(-1);
    const slice = types.slice(idx, idx + 800);
    for (const col of REQUIRED_COLUMNS) {
      expect(slice).toContain(col);
    }
  });
});
