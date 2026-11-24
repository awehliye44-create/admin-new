/**
 * Lock: every document / vehicle / vehicle-change write is captured by DB
 * triggers into the append-only driver_compliance_audit_log, and a vehicle's
 * rejection reason only survives while the vehicle is rejected.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(process.cwd(), 'supabase/migrations');
const all = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(join(dir, f), 'utf8'));
const sql = all.find((s) => s.includes('CREATE TABLE public.driver_compliance_audit_log')) ?? '';
const docSql = all.find((s) => s.includes('CREATE TRIGGER zz_documents_clear_stale_rejection_reason')) ?? '';

describe('driverComplianceAuditLock', () => {
  it('clears a vehicle rejection reason whenever status is not rejected', () => {
    expect(sql).toMatch(/IF NEW\.approval_status IS DISTINCT FROM 'rejected' THEN\s+NEW\.rejection_reason := NULL;/);
    expect(sql).toMatch(/CREATE TRIGGER vehicles_clear_stale_rejection_reason\s+BEFORE INSERT OR UPDATE ON public\.vehicles/);
  });

  it('clears a document rejection reason whenever status is not rejected', () => {
    expect(docSql).toMatch(/IF NEW\.status IS DISTINCT FROM 'rejected' THEN\s+NEW\.rejection_reason := NULL;/);
    expect(docSql).toMatch(/BEFORE INSERT OR UPDATE ON public\.documents/);
  });

  it('audits documents, vehicles and vehicle change requests at the database', () => {
    expect(sql).toMatch(/AFTER INSERT OR UPDATE OR DELETE ON public\.documents/);
    expect(sql).toMatch(/AFTER INSERT OR UPDATE OR DELETE ON public\.vehicles/);
    expect(sql).toMatch(/AFTER INSERT OR UPDATE ON public\.vehicle_change_requests/);
  });

  it('keeps the audit log append-only and staff-read-only', () => {
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON public\.driver_compliance_audit_log/);
    expect(sql).toMatch(/GRANT SELECT ON public\.driver_compliance_audit_log TO authenticated;/);
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE)[^;]*driver_compliance_audit_log TO authenticated/);
  });
});
