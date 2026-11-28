/**
 * LOCK — defects found during local authenticated vehicle E2E / Storage.
 * Fix code — never soften.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('vehicle lifecycle local E2E defect fixes lock', () => {
  const op = read(
    'supabase/migrations/20270305140000_vehicle_approved_operational_updates.sql',
  );
  const reactivate = read(
    'supabase/migrations/20270305150000_admin_reactivate_v_doc_record_fix.sql',
  );
  const current = read(
    'supabase/migrations/20270305160000_documents_current_per_vehicle_unique.sql',
  );
  const guard = read(
    'supabase/migrations/20270305170000_guard_preserve_rejected_on_versioning_demote.sql',
  );
  const docsVehicles = read(
    'supabase/migrations/20270305180000_documents_page_vehicles_read_upload_audit.sql',
  );
  const dualSide = read(
    'supabase/migrations/20270305190000_replacement_dual_side_attach_reuse.sql',
  );

  it('approved vehicles allow operational updates without identity rewrite for non-admins', () => {
    expect(op).toContain('v_identity_changed');
    expect(op).toContain('NEW.approval_status := OLD.approval_status');
    expect(op).toMatch(/Cannot modify approved vehicle information/);
  });

  it('reactivate FOR-loop uses record not jsonb for v_doc.j', () => {
    const start = reactivate.indexOf(
      'CREATE OR REPLACE FUNCTION public.admin_reactivate_driver_vehicle',
    );
    const end = reactivate.indexOf('\n$$;', start);
    const fn = reactivate.slice(start, end);
    expect(fn).toContain('v_doc record');
    expect(fn).toContain("v_doc.j->>'state'");
    expect(fn).not.toMatch(/\bv_doc jsonb;/);
  });

  it('current documents are unique per vehicle, not driver-wide for vehicle-scoped types', () => {
    expect(current).toContain('DROP INDEX IF EXISTS public.uniq_documents_driver_type_current');
    expect(current).toContain('uniq_documents_driver_vehicle_type_current');
    expect(current).toContain('vehicle_id IS NOT DISTINCT FROM NEW.vehicle_id');
    expect(current).toContain('is_vehicle_scoped_document_slug');
  });

  it('guard preserves rejected/expired status on versioning demote during re-upload', () => {
    expect(guard).toContain("'approved', 'rejected', 'expired'");
    expect(guard).toContain('document_update_is_versioning_only');
    expect(guard).toMatch(/NEW\.status := 'pending'/);
  });

  it('documents page may SELECT vehicles for vehicle-scoped review hydration', () => {
    expect(docsVehicles).toContain("ADD COLUMN IF NOT EXISTS upload_source");
    expect(docsVehicles).toContain("_admin_page_table_allowed");
    expect(docsVehicles).toMatch(
      /WHEN 'vehicles' THEN[\s\S]*'documents'[\s\S]*'document-management'/,
    );
  });

  it('replacement dual-side submit reuses target pending document and aggregates sides', () => {
    expect(dualSide).toContain('v_upload_target');
    expect(dualSide).toContain('resolve_vehicle_document_target');
    expect(dualSide).toContain('is_vehicle_scoped_document_slug');
    expect(dualSide).toContain('d_side.vehicle_id IS NOT DISTINCT FROM v_target');
    expect(dualSide).toContain("da.side IN ('front', 'back')");
  });
});
