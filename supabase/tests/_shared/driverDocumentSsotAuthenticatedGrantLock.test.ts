/**
 * LOCK — authenticated drivers must be able to SELECT driver_document_compliance_ssot.
 * The view calls resolve_trip_active_vehicle_id; revoking EXECUTE from authenticated
 * makes My Documents show "Documents could not be loaded." after Add Vehicle.
 * If this fails, fix the grant — never delete or soften the lock.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('driver document SSOT authenticated grant lock', () => {
  it('restores authenticated EXECUTE on resolve_trip_active_vehicle_id after vehicle SSOT', () => {
    const grant = read(
      'supabase/migrations/20270305230000_ssot_resolve_trip_active_grant_authenticated.sql',
    );
    expect(grant).toContain('resolve_trip_active_vehicle_id');
    expect(grant).toContain(
      'GRANT EXECUTE ON FUNCTION public.resolve_trip_active_vehicle_id(uuid) TO authenticated, service_role',
    );
    expect(grant).toContain('current_driver_id()');
    expect(grant).toContain('v_caller IS DISTINCT FROM p_driver_id');

    const view = read(
      'supabase/migrations/20270305110000_vehicle_lifecycle_ui_and_upload_hardening.sql',
    );
    expect(view).toContain('resolve_trip_active_vehicle_id');
    expect(view).toContain('CREATE OR REPLACE VIEW public.driver_document_compliance_ssot');
  });
});
