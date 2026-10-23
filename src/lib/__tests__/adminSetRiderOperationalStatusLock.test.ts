import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

describe('admin_set_rider_operational_status lock', () => {
  it('migration defines admin RPC with session revoke on lock', () => {
    const sql = read(
      'supabase/migrations/20261223130000_admin_set_rider_operational_status_lock.sql',
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.admin_set_rider_operational_status\(/,
    );
    expect(sql).toMatch(/has_role\(v_uid, 'admin'::public\.app_role\)/);
    expect(sql).toMatch(/DELETE FROM auth\.sessions/);
    expect(sql).toMatch(/DELETE FROM auth\.refresh_tokens/);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.admin_set_rider_operational_status\(uuid, text, text\) TO authenticated/,
    );
  });

  it('Admin Riders UI uses RPC helper for suspend/disable/enable', () => {
    const client = read('src/lib/adminSetRiderOperationalStatus.ts');
    expect(client).toMatch(/admin_set_rider_operational_status/);

    const page = read('src/pages/Riders.tsx');
    expect(page).toMatch(/adminSetRiderOperationalStatus/);
    expect(page).not.toMatch(
      /\.from\(['"]customers['"]\)[\s\S]{0,80}\.update\(\{\s*rider_status:/,
    );

    const dialog = read('src/components/riders/RiderDetailsDialog.tsx');
    expect(dialog).toMatch(/adminSetRiderOperationalStatus/);
  });
});
