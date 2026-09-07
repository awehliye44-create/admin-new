/**
 * Lock: Phase 3 Batch 2 mutable search_path fix for four INVOKER helpers.
 * If this fails, fix the migration — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261107170000_phase3_batch2_mutable_search_path_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261107170000_phase3_batch2_mutable_search_path_lock.sql';

const FOUR = [
  'payout_ledger_type_is_payout_eligible',
  'scrub_campaign_heads_up_taxi_branding',
  'driver_wallet_captured_at_restamp_suspect',
  'driver_wallet_stable_clearing_origin',
] as const;

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phase3Batch2MutableSearchPathLock', () => {
  it('only ALTERs search_path — no CREATE OR REPLACE / ACL / logic edits', () => {
    const sql = read(CANONICAL);
    expect(sql).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
    expect(sql).not.toMatch(/\bGRANT\b/i);
    expect(sql).not.toMatch(/\bREVOKE\b/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE/i);
    expect(sql).not.toMatch(/cron\.(schedule|unschedule)/i);
    for (const name of FOUR) {
      expect(sql).toMatch(
        new RegExp(
          String.raw`ALTER\s+FUNCTION\s+public\.${name}[\s\S]*?SET\s+search_path\s+TO\s+pg_catalog`,
          'i',
        ),
      );
    }
  });

  it('uses pg_catalog only (narrowest safe path for builtin-only bodies)', () => {
    const sql = read(CANONICAL);
    expect(sql).toMatch(/SET\s+search_path\s+TO\s+pg_catalog/i);
    expect(sql).not.toMatch(/SET\s+search_path\s+TO\s+'public'/i);
    expect(sql).not.toMatch(/SET\s+search_path\s+TO\s+public\b/i);
  });

  it('rollback RESETs search_path on the same four signatures', () => {
    const rb = read(ROLLBACK);
    expect(rb).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
    expect(rb).not.toMatch(/\bGRANT\b/i);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    for (const name of FOUR) {
      expect(rb).toMatch(
        new RegExp(
          String.raw`ALTER\s+FUNCTION\s+public\.${name}[\s\S]*?RESET\s+search_path`,
          'i',
        ),
      );
    }
  });
});
