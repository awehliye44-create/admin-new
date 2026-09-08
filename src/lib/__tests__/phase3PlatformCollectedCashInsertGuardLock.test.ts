/**
 * Lock: PLATFORM_COLLECTED + cash insert/update guard.
 * Draft only. If this fails, fix the migration — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261107214500_phase3_platform_collected_cash_insert_guard.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261107214500_phase3_platform_collected_cash_insert_guard.sql';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phase3PlatformCollectedCashInsertGuardLock', () => {
  it('rejects platform collected cash after the model stamp and denies service_role by default', () => {
    const sql = read(CANONICAL);
    expect(sql).toMatch(/NOT APPLIED/);
    expect(sql).toMatch(/trg_01_reject_platform_collected_operational_cash/);
    expect(sql).toMatch(/trg_00_stamp_trip_financial_model_on_insert/);
    expect(sql).toMatch(/FINANCIAL_MODEL_VIOLATION/);
    expect(sql).toMatch(/PLATFORM_COLLECTED/);
    expect(sql).toMatch(/phase3_migration_only/);
    expect(sql).toMatch(/completed', 'cancelled', 'canceled', 'expired', 'no_show'/);
    expect(sql).not.toMatch(/\bCHECK\b/i);
    expect(sql).not.toMatch(/UPDATE public\.trips/i);
    expect(sql).not.toMatch(/INSERT INTO public\.trips/i);
    expect(sql).not.toMatch(/DRIVER_COLLECTED_COMMISSION_WALLET/);
  });

  it('rollback drops only the draft guard', () => {
    const rb = read(ROLLBACK);
    expect(rb).toMatch(/DROP TRIGGER IF EXISTS trg_01_reject_platform_collected_operational_cash/);
    expect(rb).toMatch(/DROP FUNCTION IF EXISTS public\.reject_platform_collected_operational_cash/);
    expect(rb).not.toMatch(/UPDATE public\.trips/i);
    expect(rb).not.toMatch(/INSERT INTO public\.trips/i);
    expect(rb).not.toMatch(/GRANT /i);
  });
});
