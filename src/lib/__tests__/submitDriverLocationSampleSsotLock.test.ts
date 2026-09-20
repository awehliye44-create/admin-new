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
const DIAG =
  'supabase/migrations/20261113090000_driver_location_publish_diagnostics.sql';

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

  it('records reason-coded publish diags with 72h retention (20261113090000)', () => {
    const sql = read(DIAG);
    expect(sql).toContain('driver_location_publish_diagnostics');
    expect(sql).toContain('record_driver_location_publish_diag');
    expect(sql).toContain('purge_driver_location_publish_diagnostics');
    expect(sql).toContain("interval '72 hours'");
    expect(sql).toContain('TRIP_MIRRORED');
    expect(sql).toContain('TRIP_NOT_LIVE');
    expect(sql).toContain('TRIP_DRIVER_MISMATCH');
    expect(sql).toContain('STALE_SAMPLE');
    expect(sql).toContain('OUT_OF_ORDER_SAMPLE');
    expect(sql).toContain('PRESENCE_REJECTED');
    expect(sql).toContain('reason_code');
    expect(sql).toContain('presence_updated');
    // Diagnostics table itself must not store coordinates (canonical tables still do).
    const tableCreate = sql.slice(
      sql.indexOf('CREATE TABLE IF NOT EXISTS public.driver_location_publish_diagnostics'),
      sql.indexOf('COMMENT ON TABLE public.driver_location_publish_diagnostics'),
    );
    expect(tableCreate).not.toMatch(/\blatitude\b/);
    expect(tableCreate).not.toMatch(/\blongitude\b/);
    expect(sql).toContain('No coordinates');
  });

  it('gap-close keeps TRIP_MIRRORED honest and online_intent from drivers (20261117120000)', () => {
    const sql = read(
      'supabase/migrations/20261117120000_driver_location_publish_diagnostics_gap_close.sql',
    );
    expect(sql).toContain('GET DIAGNOSTICS v_tdll_rows = ROW_COUNT');
    expect(sql).toContain('TRIP_MIRROR_STALE_SKIPPED');
    expect(sql).toContain("v_reason := 'NO_ACTIVE_TRIP'");
    expect(sql).toContain('driver_online_intent');
    expect(sql).toContain('DRIVER_ID_REQUIRED');
    expect(sql).toContain('GPS_RECORDED_AT_REQUIRED');
  });
});
