/**
 * Lock: Phase 3 Batch 3D4 invoice number authorization.
 * If this fails, fix the migration — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261107214000_phase3_batch3d4_invoice_number_authz_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261107214000_phase3_batch3d4_invoice_number_authz_lock.sql';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phase3Batch3d4InvoiceNumberAuthzLock', () => {
  it('gates statement-runs without revoking authenticated EXECUTE or changing the sequence loop', () => {
    const sql = read(CANONICAL);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).toMatch(/staff_has_page_access\('statement-runs'\)/);
    expect(sql).toMatch(/auth\.role\(\) IS DISTINCT FROM 'service_role'/);
    expect(sql).toMatch(/driver_invoice_monthly_sequences/);
    expect(sql).not.toMatch(/REVOKE ALL ON FUNCTION public\.generate_invoice_number/);
    expect(sql).not.toMatch(/record_cash_trip_completion/);
    const rb = read(ROLLBACK);
    expect(rb).toMatch(/CREATE OR REPLACE FUNCTION public\.generate_invoice_number/);
    expect(rb).not.toMatch(/staff_has_page_access/);
    expect(rb).not.toMatch(/\bREVOKE\b/i);
  });
});
