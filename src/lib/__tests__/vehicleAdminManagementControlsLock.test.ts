/**
 * LOCK — Admin vehicle/document management controls.
 * Server authz (page RBAC), reason-gated destructive actions, soft-archive/retire,
 * no cascade deletes, audit fields. Fix code — never soften this lock.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('vehicle admin management controls lock', () => {
  const mig = read(
    'supabase/migrations/20270305120000_vehicle_admin_management_controls.sql',
  );
  const lib = read('src/lib/vehicleLifecycleAdmin.ts');
  const vehicles = read('src/pages/Vehicles.tsx');
  const details = read('src/components/drivers/DriverDetailsDialog.tsx');
  const docs = read('src/pages/Documents.tsx');
  const edit = read('src/components/vehicles/AdminVehicleEditDialog.tsx');

  it('lifecycle Admin RPCs use page RBAC, not has_role-only', () => {
    expect(mig).toMatch(/staff_has_any_page_access\(ARRAY\['vehicles',\s*'drivers'\]\)/);
    expect(mig).toMatch(/staff_has_any_page_access\(ARRAY\['documents',\s*'drivers'\]\)/);
    expect(mig).toMatch(
      /staff_has_any_page_access\(ARRAY\['vehicles',\s*'documents',\s*'drivers'\]\)/,
    );
    expect(mig).toContain('admin_set_trip_active_vehicle');
    expect(mig).toContain('admin_suspend_driver_vehicle');
    expect(mig).toContain('admin_archive_driver_vehicle');
    expect(mig).toContain('admin_retire_document');
    expect(mig).toContain('REASON_REQUIRED');
    expect(mig).toContain('documents_preserved');
    expect(mig).not.toMatch(/DELETE\s+FROM\s+public\.documents/i);
    expect(mig).not.toMatch(/DELETE\s+FROM\s+public\.vehicles/i);
  });

  it('compliance audit diffs include lifecycle and vehicle linkage fields', () => {
    expect(mig).toContain('operational_status');
    expect(mig).toContain('is_trip_active');
    expect(mig).toContain('suspended_reason');
    expect(mig).toContain('ambiguity_review_required');
    expect(mig).toContain("'vehicle_id'");
  });

  it('client routes edits and lifecycle through gated mutate / dedicated RPCs', () => {
    expect(edit).toContain('adminPageMutate');
    expect(edit).toContain('rejection_reason');
    expect(edit).not.toMatch(/\.from\(['"]vehicles['"]\)\s*\.update/);
    expect(lib).toContain('admin_set_trip_active_vehicle');
    expect(lib).toContain('admin_suspend_driver_vehicle');
    expect(lib).toContain('admin_archive_driver_vehicle');
    expect(lib).toContain('admin_retire_document');
    expect(lib).toContain('REASON_REQUIRED');
  });

  it('Vehicles and Driver Details expose set-active / suspend / archive / return with reasons', () => {
    expect(vehicles).toContain('AdminVehicleReasonDialog');
    expect(vehicles).toContain('Set Active');
    expect(vehicles).toContain('Suspend');
    expect(vehicles).toContain('adminArchiveDriverVehicle');
    expect(vehicles).toContain('assignReason');
    expect(details).toContain('AdminVehicleReasonDialog');
    expect(details).toContain('adminSetTripActiveVehicle');
    expect(details).toContain('adminSuspendDriverVehicle');
    expect(details).toContain('adminArchiveDriverVehicle');
  });

  it('Documents soft-retire live rows and require reason for hard purge', () => {
    expect(docs).toContain('adminRetireDocument');
    expect(docs).toContain('Remove from active use');
    expect(docs).toContain('Edit metadata');
    expect(docs).toContain('purgeReason');
    expect(docs).toContain('A reason is required for permanent deletion');
    expect(docs).toContain('Show history');
    expect(docs).toContain('adminResolveDocumentVehicleLink');
    expect(docs).toContain('groupDocumentsIntoVersionChains');
    expect(docs).toContain('versionLifecycleLabel');
    expect(docs).toMatch(/Current|Retired/);
  });

  it('shared reassignment copy states driver-private docs stay private', () => {
    expect(vehicles).toMatch(/driver-private docs are never/i);
    expect(mig).toContain('admin_assign_shared_vehicle');
  });
});
