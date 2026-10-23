import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const MIGRATION =
  'supabase/migrations/20261223120000_admin_set_driver_operational_status_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261223120000_admin_set_driver_operational_status_lock.sql';
const CLIENT = 'src/lib/adminSetDriverOperationalStatus.ts';
const DRIVERS_PAGE = 'src/pages/Drivers.tsx';
const DRIVER_DIALOG = 'src/components/drivers/DriverDetailsDialog.tsx';

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

describe('admin_set_driver_operational_status lock', () => {
  it('migration defines admin RPC with admin authz and intent clear', () => {
    const sql = read(MIGRATION);
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.admin_set_driver_operational_status\(/,
    );
    expect(sql).toMatch(/has_role\(v_uid, 'admin'::public\.app_role\)/);
    expect(sql).toMatch(/allow_driver_availability_write\(\)/);
    expect(sql).toMatch(/driver_online_intent := false/);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.admin_set_driver_operational_status\(uuid, public\.driver_status\) TO authenticated/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.admin_set_driver_operational_status\(uuid, public\.driver_status\) FROM service_role/,
    );
    expect(read(ROLLBACK)).toMatch(
      /DROP FUNCTION IF EXISTS public\.admin_set_driver_operational_status/,
    );
  });

  it('Admin UI uses RPC helper — not direct drivers.driver_status updates for enable/disable', () => {
    const client = read(CLIENT);
    expect(client).toMatch(/admin_set_driver_operational_status/);
    expect(client).not.toMatch(/\.from\(['"]drivers['"]\)/);

    for (const page of [DRIVERS_PAGE, DRIVER_DIALOG]) {
      const src = read(page);
      expect(src).toMatch(/adminSetDriverOperationalStatus/);
      expect(src).not.toMatch(
        /\.from\(['"]drivers['"]\)\s*\n\s*\.update\(\{\s*driver_status:/,
      );
    }
  });
});
