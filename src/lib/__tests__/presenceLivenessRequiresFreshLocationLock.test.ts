/**
 * Lock MK-260928-003: a coordinate-free heartbeat must never keep a driver live.
 * If this fails, fix the migration — never delete or soften the lock.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const MIGRATION =
  'supabase/migrations/20261204120000_presence_liveness_requires_fresh_location.sql';

const sql = fs.readFileSync(path.join(ROOT, MIGRATION), 'utf8');

describe('presenceLivenessRequiresFreshLocationLock', () => {
  it('derives liveness only from an accepted sample or a gps-fresh stored location', () => {
    expect(sql).toMatch(
      /v_liveness_has_fresh_location :=\s*v_accept_location\s*OR \(\s*v_prev\.last_location_at IS NOT NULL\s*AND v_prev\.last_location_at > v_now - make_interval\(secs => \(v_thresholds->>'gps_fresh_seconds'\)::int\)/,
    );
  });

  it('gates last_heartbeat_at on fresh location for insert and update', () => {
    expect(sql).toContain(
      "CASE WHEN v_liveness_has_fresh_location THEN v_now ELSE 'epoch'::timestamptz END",
    );
    expect(sql).toContain(
      'last_heartbeat_at = CASE WHEN v_liveness_has_fresh_location THEN v_now ELSE public.driver_presence.last_heartbeat_at END',
    );
    expect(sql).not.toMatch(/last_heartbeat_at = v_now\b/);
  });

  it('gates drivers.last_seen_at and healthy presence on fresh location', () => {
    expect(sql).toContain(
      'last_seen_at = CASE WHEN v_liveness_has_fresh_location THEN v_now ELSE last_seen_at END',
    );
    expect(sql).not.toMatch(/last_seen_at = v_now,/);
    expect(sql).toMatch(
      /WHEN COALESCE\(v_driver\.driver_online_intent, false\) AND v_liveness_has_fresh_location THEN 'healthy'/,
    );
  });

  it('keeps the MK-260921-006 pure-heartbeat throttle and never throttles GPS samples', () => {
    expect(sql).toMatch(
      /IF p_gps_recorded_at IS NULL\s*AND v_gap_s < 2\s*AND COALESCE\(p_status, ''\) <> 'offline'/,
    );
  });

  it('keeps the drivers.is_online derivation unchanged', () => {
    expect(sql).toContain('is_online = v_effective_online,');
  });
});
