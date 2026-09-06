/**
 * Lock: Phase 2A EXECUTE revoke on campaign_heads_up_due_sweep + check_identity_exists.
 *
 * If this fails, fix the migration / callers — never delete or soften the lock.
 *
 * Protects against:
 *   - recreating functions that re-GRANT EXECUTE to PUBLIC/anon/authenticated
 *   - dropping the revoke migration without a stricter replacement
 *   - Edge create-onboarding-auth-user calling check_identity_exists without service_role
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');
const CANONICAL =
  'supabase/migrations/20261107130000_phase2a_anon_secdef_execute_revoke_lock.sql';
const EDGE =
  'supabase/functions/create-onboarding-auth-user/index.ts';
const CRON_MIGRATION =
  'supabase/migrations/20261027120000_campaign_heads_up_due_sweep_cron.sql';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function listSqlMigrations(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

describe('phase2aAnonSecdefExecuteRevokeLock', () => {
  it('canonical migration revokes PUBLIC+anon(+authenticated) and keeps service_role for identity check only', () => {
    const sql = read(CANONICAL);

    // Campaign: strip all API roles including PUBLIC and service_role.
    expect(sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.campaign_heads_up_due_sweep\s*\(\s*\)\s+FROM\s+PUBLIC/i,
    );
    expect(sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.campaign_heads_up_due_sweep\s*\(\s*\)\s+FROM\s+anon/i,
    );
    expect(sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.campaign_heads_up_due_sweep\s*\(\s*\)\s+FROM\s+authenticated/i,
    );
    expect(sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.campaign_heads_up_due_sweep\s*\(\s*\)\s+FROM\s+service_role/i,
    );
    expect(sql).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.campaign_heads_up_due_sweep\s*\(/i,
    );

    // Identity: revoke PUBLIC/anon/authenticated; grant service_role only.
    expect(sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.check_identity_exists\s*\(\s*text\s*,\s*text\s*\)\s+FROM\s+PUBLIC/i,
    );
    expect(sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.check_identity_exists\s*\(\s*text\s*,\s*text\s*\)\s+FROM\s+anon/i,
    );
    expect(sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.check_identity_exists\s*\(\s*text\s*,\s*text\s*\)\s+FROM\s+authenticated/i,
    );
    expect(sql).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.check_identity_exists\s*\(\s*text\s*,\s*text\s*\)\s+TO\s+service_role/i,
    );

    // Grants-only migration — no CREATE OR REPLACE of either function.
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.campaign_heads_up_due_sweep/i);
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.check_identity_exists/i);
    expect(sql).not.toMatch(/cron\.(schedule|unschedule)/i);
  });

  it('no later migration re-grants EXECUTE to PUBLIC/anon/authenticated on either function', () => {
    const canonicalName = path.basename(CANONICAL);
    for (const file of listSqlMigrations()) {
      if (file <= canonicalName) continue;
      const body = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

      const campaignGrant = body.match(
        /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.campaign_heads_up_due_sweep\s*\([^)]*\)\s+TO\s+([^;]+)/gi,
      );
      if (campaignGrant) {
        for (const g of campaignGrant) {
          expect(g).not.toMatch(/\bPUBLIC\b/i);
          expect(g).not.toMatch(/\banon\b/i);
          expect(g).not.toMatch(/\bauthenticated\b/i);
          expect(g).not.toMatch(/\bservice_role\b/i);
        }
      }

      const identityGrant = body.match(
        /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.check_identity_exists\s*\([^)]*\)\s+TO\s+([^;]+)/gi,
      );
      if (identityGrant) {
        for (const g of identityGrant) {
          expect(g).not.toMatch(/\bPUBLIC\b/i);
          expect(g).not.toMatch(/\banon\b/i);
          expect(g).not.toMatch(/\bauthenticated\b/i);
          // service_role re-grant is allowed
        }
      }
    }
  });

  it('create-onboarding-auth-user calls check_identity_exists via service_role client', () => {
    const src = read(EDGE);
    expect(src).toMatch(/createClient\s*\(\s*supabaseUrl\s*,\s*serviceKey/);
    expect(src).toMatch(/service\.rpc\s*\(\s*["']check_identity_exists["']/);
    // Must not call identity check through the anon client.
    expect(src).not.toMatch(/anon\.rpc\s*\(\s*["']check_identity_exists["']/);
  });

  it('campaign cron migration schedules SELECT as postgres-owned job (no client role required)', () => {
    const cron = read(CRON_MIGRATION);
    expect(cron).toMatch(/cron\.schedule\s*\(/);
    expect(cron).toMatch(/campaign-heads-up-due-sweep/);
    expect(cron).toMatch(/SELECT\s+public\.campaign_heads_up_due_sweep\s*\(\s*\)/);
  });

  it('emergency rollback restores prior grants and lives next to the forward migration', () => {
    const rollback = read(
      'supabase/migrations/rollback/rollback_20261107130000_phase2a_anon_secdef_execute_revoke_lock.sql',
    );
    expect(rollback).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.campaign_heads_up_due_sweep\s*\(\s*\)\s+TO\s+PUBLIC/i,
    );
    expect(rollback).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.check_identity_exists\s*\(\s*text\s*,\s*text\s*\)\s+TO\s+anon/i,
    );
    expect(fs.existsSync(path.join(ROOT, CANONICAL))).toBe(true);
  });
});
