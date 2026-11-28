/**
 * LOCK — Admin Vehicles list uses page-authorized reads + per-vehicle doc compliance.
 * Unauthorized staff must not read vehicle/document details via direct table selects.
 * Fix code — never soften this lock.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('vehicle list authorized read + compliance summary lock', () => {
  const mig = read(
    'supabase/migrations/20270305130000_admin_vehicle_list_doc_compliance_history.sql',
  );
  const lib = read('src/lib/vehicleLifecycleAdmin.ts');
  const vehicles = read('src/pages/Vehicles.tsx');

  it('adds page-RBAC RPCs for change requests and per-vehicle compliance', () => {
    expect(mig).toContain('admin_list_vehicle_change_requests');
    expect(mig).toContain('admin_vehicle_document_compliance_summaries');
    expect(mig).toMatch(/staff_has_any_page_access\(ARRAY\['vehicles',\s*'drivers'\]\)/);
    expect(mig).toMatch(
      /staff_has_any_page_access\(ARRAY\['vehicles',\s*'drivers',\s*'documents'\]\)/,
    );
    expect(mig).toMatch(/REVOKE ALL ON FUNCTION public\.admin_list_vehicle_change_requests/);
    expect(mig).toMatch(
      /REVOKE ALL ON FUNCTION public\.admin_vehicle_document_compliance_summaries/,
    );
    expect(mig).not.toMatch(/GRANT EXECUTE[^;]*TO anon/i);
  });

  it('compliance intersects SA required docs with vehicle_change_document_slugs for THAT vehicle only', () => {
    expect(mig).toContain('vehicle_change_document_slugs()');
    expect(mig).toContain('get_driver_document_eligibility_internal');
    expect(mig).toContain("d.vehicle_id = v_vehicle.id");
    expect(mig).toContain("'action_needed'");
    expect(mig).toContain("'pending_review'");
    expect(mig).toContain("'complete'");
    expect(mig).toContain("'missing'");
    expect(mig).toContain("'expired'");
    // Must not treat null vehicle_id (driver-level) as matching this vehicle.
    expect(mig).not.toMatch(/d\.vehicle_id\s+IS\s+NOT\s+DISTINCT\s+FROM\s+v_vehicle\.id/);
  });

  it('Vehicles page uses adminPageSelect / lifecycle RPCs — never direct vehicles or change-request tables', () => {
    expect(vehicles).toContain("adminPageSelect");
    expect(vehicles).toContain("adminLookupByIds");
    expect(vehicles).toContain('adminVehicleDocumentComplianceSummaries');
    expect(vehicles).toContain('adminListVehicleChangeRequests');
    expect(vehicles).toContain('Documents');
    expect(vehicles).not.toMatch(/\.from\(\s*['"]vehicles['"]\s*\)/);
    expect(vehicles).not.toMatch(/\.from\(\s*['"]vehicle_change_requests['"]\s*\)/);
    expect(lib).toContain('admin_list_vehicle_change_requests');
    expect(lib).toContain('admin_vehicle_document_compliance_summaries');
  });
});
