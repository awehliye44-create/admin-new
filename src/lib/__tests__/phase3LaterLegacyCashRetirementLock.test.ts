/**
 * Lock: later legacy cash completion retirement.
 * If this fails, fix the migration — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261107215000_phase3_later_legacy_cash_retirement.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261107215000_phase3_later_legacy_cash_retirement.sql';
const SIG = 'public.record_cash_trip_completion(uuid, uuid, integer, integer, text)';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phase3LaterLegacyCashRetirementLock', () => {
  it('replaces the writer with a digital-only exception and revokes service_role', () => {
    const sql = read(CANONICAL);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).toMatch(/RETURNS uuid/);
    expect(sql).toMatch(/FINANCIAL_MODEL_VIOLATION/);
    expect(sql).toMatch(/ONECAB is digital-only/);
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${SIG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} FROM PUBLIC`));
    expect(sql).toMatch(/FROM anon/);
    expect(sql).toMatch(/FROM authenticated/);
    expect(sql).toMatch(/FROM service_role/);
    expect(sql).not.toMatch(/FROM postgres/i);
    expect(sql).not.toMatch(/GRANT EXECUTE/i);
    expect(sql).not.toMatch(/DROP FUNCTION/i);
    expect(sql).not.toMatch(/UPDATE trips/i);
    expect(sql).not.toMatch(/INSERT INTO driver_ledger/i);
    expect(sql).not.toMatch(/RETURNS jsonb/i);
  });

  it('rollback restores the original writer and service_role EXECUTE only', () => {
    const rb = read(ROLLBACK);
    expect(rb).toMatch(/RETURNS uuid/);
    expect(rb).toMatch(/INSERT INTO driver_ledger/);
    expect(rb).toMatch(/CASH_COMMISSION_DEBT/);
    expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${SIG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} TO service_role`));
    expect(rb).not.toMatch(/FINANCIAL_MODEL_VIOLATION/);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
    expect(rb).not.toMatch(/TO authenticated/i);
    expect(rb).not.toMatch(/DROP FUNCTION/i);
  });
});
