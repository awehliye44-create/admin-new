import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

describe('admin_set_rider_operational_status lock', () => {
  it('latest admin RPC never revokes Customer sessions (banner workflow)', () => {
    const sql = read(
      'supabase/migrations/20261228193000_admin_rider_status_keep_session_for_banner.sql',
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.admin_set_rider_operational_status\(/,
    );
    expect(sql).toMatch(/has_role\(v_uid, 'admin'::public\.app_role\)/);
    expect(sql).toMatch(/sessions_revoked', false/);
    expect(sql).not.toMatch(/DELETE FROM auth\.sessions/);
    expect(sql).not.toMatch(/DELETE FROM auth\.refresh_tokens/);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.admin_set_rider_operational_status\(uuid, text, text\) TO authenticated/,
    );
  });

  it('Admin Riders UI uses RPC helper and never promises a Customer sign-out', () => {
    const client = read('src/lib/adminSetRiderOperationalStatus.ts');
    expect(client).toMatch(/admin_set_rider_operational_status/);

    const page = read('src/pages/Riders.tsx');
    expect(page).toMatch(/adminSetRiderOperationalStatus/);
    expect(page).not.toMatch(
      /\.from\(['"]customers['"]\)[\s\S]{0,80}\.update\(\{\s*rider_status:/,
    );
    expect(page).not.toMatch(/signed out of Customer app/);
    expect(page).toMatch(/restriction banner/);

    const dialog = read('src/components/riders/RiderDetailsDialog.tsx');
    expect(dialog).toMatch(/adminSetRiderOperationalStatus/);
    expect(dialog).not.toMatch(/signed out of Customer app/);
    expect(dialog).toMatch(/restriction banner/);
  });
});
