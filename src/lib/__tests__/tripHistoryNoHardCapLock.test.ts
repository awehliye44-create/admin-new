/**
 * Lock: ONECAB must never hard-cap trip history at 500 (or 2000) for Admin/finance.
 * Admin tables paginate (default 50/100). Full history stays in DB permanently.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TRIP_HISTORY_PAGE_SIZE_DEFAULT,
  TRIP_HISTORY_PAGE_SIZE_OPTIONS,
  TRIP_HISTORY_REQUEST_SAFETY_MAX,
  resolveTripHistoryPageSize,
  encodeTripHistoryCursor,
  decodeTripHistoryCursor,
} from '../tripHistoryQuery';

const ROOT = join(__dirname, '../../..');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('trip history — no hard 500/2000 history cap', () => {
  it('defaults Admin page size to 100 (or 50), never 500/2000 as the only window', () => {
    expect(TRIP_HISTORY_PAGE_SIZE_DEFAULT).toBe(100);
    expect([...TRIP_HISTORY_PAGE_SIZE_OPTIONS]).toEqual([50, 100]);
    expect(resolveTripHistoryPageSize(null)).toBe(100);
    expect(resolveTripHistoryPageSize(50)).toBe(50);
    expect(resolveTripHistoryPageSize(9999)).toBe(TRIP_HISTORY_REQUEST_SAFETY_MAX);
    expect(TRIP_HISTORY_REQUEST_SAFETY_MAX).toBeLessThan(500);
  });

  it('tripHistoryQuery uses cursor pages — not .limit(2000) / .limit(500)', () => {
    const src = read('src/lib/tripHistoryQuery.ts');
    expect(src).toContain('fetchTripHistoryPage');
    expect(src).toContain('pageSize + 1');
    expect(src).toContain('nextCursor');
    expect(src).not.toMatch(/\.limit\(\s*2000\s*\)/);
    expect(src).not.toMatch(/\.limit\(\s*500\s*\)/);
    expect(src).toMatch(/ilike\(\s*['"]trip_code['"]/);
    expect(src).toContain("eq('driver_id'");
    expect(src).toContain("eq('passenger_id'");
  });

  it('TripHistory UI wires Load more + page size + status filter', () => {
    const page = read('src/pages/TripHistory.tsx');
    expect(page).toContain('fetchTripHistoryPage');
    expect(page).toContain('Load more trips');
    expect(page).toContain('TRIP_HISTORY_PAGE_SIZE_OPTIONS');
    expect(page).toContain('statusFilter');
    expect(page).not.toContain('fetchTripHistoryRows({');
  });

  it('cursor encode/decode round-trips', () => {
    const encoded = encodeTripHistoryCursor({
      completedAt: '2026-08-01T12:00:00.000Z',
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    expect(decodeTripHistoryCursor(encoded)).toEqual({
      completedAt: '2026-08-01T12:00:00.000Z',
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    expect(decodeTripHistoryCursor(null)).toBeNull();
  });

  it('FR summary no longer defaults to silent 500 under-sample', () => {
    const src = read('supabase/functions/_shared/financeReconciliationTripQuery.ts');
    expect(src).not.toMatch(/raw \|\| 500/);
    expect(src).toContain('FINANCE_RECONCILIATION_TRIP_AUDIT_LIMIT_DEFAULT = 10_000');
  });

  it('finance-backend-audit-v1 does not default audit_limit to 500', () => {
    const src = read('supabase/functions/finance-backend-audit-v1/index.ts');
    expect(src).not.toMatch(/audit_limit"\) \|\| 500/);
    expect(src).toMatch(/audit_limit"\) \|\| 10_000/);
  });

  it('repair-commissions pages batches instead of first-500-only', () => {
    const src = read('supabase/functions/repair-commissions/index.ts');
    expect(src).toContain('REPAIR_BATCH');
    expect(src).toContain('repairCursorCompletedAt');
    expect(src).toContain('for (;;)');
  });

  it('ships list indexes migration (not retention deletes)', () => {
    const mig = read(
      'supabase/migrations/20260827120000_trip_history_list_indexes_no_hard_cap.sql',
    );
    expect(mig).toContain('idx_trips_sa_completed_id');
    expect(mig).toContain('idx_trips_driver_completed_id');
    expect(mig).toContain('idx_trips_passenger_completed_id');
    expect(mig.toLowerCase()).not.toContain('delete from trips');
  });
});
