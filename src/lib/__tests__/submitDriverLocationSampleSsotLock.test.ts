/**
 * Lock: submit_driver_location_sample soft-trip-mirror + JWT bind + jsonb diagnostics.
 * If this fails, fix the migration — never delete or soften the lock.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const SOFT =
  'supabase/migrations/20261112210000_submit_driver_location_soft_trip_mirror.sql';
const JWT =
  'supabase/migrations/20261112220000_submit_driver_location_jwt_bind_diagnostics.sql';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('submitDriverLocationSampleSsotLock', () => {
  it('soft-skips stale trip without aborting presence (20261112210000)', () => {
    const sql = read(SOFT);
    expect(sql).toContain('trip mirror skipped');
    expect(sql).toContain('v_mirror_trip_id');
    expect(sql).toContain('upsert_driver_presence');
    expect(sql).toContain('trip_driver_live_location');
    expect(sql).not.toMatch(
      /IF p_trip_id IS NOT NULL THEN[\s\S]{0,400}RAISE EXCEPTION 'TRIP_ASSIGNMENT_REJECTED/,
    );
  });

  it('JWT-binds p_driver_id and returns trip_mirror diagnostics (20261112220000)', () => {
    const sql = read(JWT);
    expect(sql).toMatch(/RETURNS jsonb/i);
    expect(sql).toContain('DRIVER_ID_MISMATCH');
    expect(sql).toContain('current_driver_id()');
    expect(sql).toContain('trip_mirrored');
    expect(sql).toContain('trip_mirror_skipped');
    expect(sql).toContain('trip_id_requested');
    expect(sql).toContain('GRANT EXECUTE');
    expect(sql).toContain('TO authenticated');
    expect(sql).toContain('TO service_role');
  });
});
