/**
 * LOCK — Vehicles → Assign uses searchable DriverSelector (not UUID paste).
 * Conflicts stay server-enforced via admin_assign_shared_vehicle.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('vehicle assign driver picker lock', () => {
  it('Assign dialog uses DriverSelector with vehicles pageSlug and identity label', () => {
    const page = read('src/pages/Vehicles.tsx');
    expect(page).toContain('DriverSelector');
    expect(page).toContain('driverOptionLabel');
    expect(page).toContain('pageSlug="vehicles"');
    expect(page).toContain('adminAssignSharedVehicle');
    expect(page).toContain('adminReturnSharedVehicleAssignment');
    expect(page).toContain('Return to fleet');
    expect(page).not.toMatch(/Paste driver UUID/i);
    expect(page).not.toMatch(/placeholder=["']Driver UUID/i);
    expect(page).not.toMatch(/<Input[^>]*assignDriverId/i);
  });

  it('assign client maps conflict codes without inventing eligibility locally', () => {
    const lib = read('src/lib/vehicleLifecycleAdmin.ts');
    expect(lib).toContain('admin_assign_shared_vehicle');
    expect(lib).toContain('ALREADY_ASSIGNED');
    expect(lib).toContain('NOT_AVAILABLE_IN_FLEET');
    expect(lib).toContain('DRIVER_NOT_FOUND');
    expect(lib).not.toMatch(/from\(['"]vehicles['"]\)\s*\.(update|insert)/);
  });

  it('assign RPC rejects open-assignment conflicts and preserves documents', () => {
    const sql = read(
      'supabase/migrations/20270305110000_vehicle_lifecycle_ui_and_upload_hardening.sql',
    );
    expect(sql).toContain('admin_assign_shared_vehicle');
    expect(sql).toContain('ALREADY_ASSIGNED');
    expect(sql).toContain('NOT_AVAILABLE_IN_FLEET');
    expect(sql).toContain('vehicle_driver_assignments');
    expect(sql).toContain('suspended_under_repair');
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.documents/i);
  });
});
