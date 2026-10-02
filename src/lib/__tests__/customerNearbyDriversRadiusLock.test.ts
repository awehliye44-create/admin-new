/**
 * Lock: Customer map nearby-driver radius is an Admin setting read server-side.
 * If this fails, fix the code — never delete or soften the lock.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const MIGRATION =
  'supabase/migrations/20261204130000_customer_nearby_drivers_radius_setting.sql';
const PAGE = 'src/pages/AutoDispatchRules.tsx';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function passengerMapFunctionBody(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.passenger_map_nearby_drivers');
  const end = sql.indexOf('$function$;', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('customerNearbyDriversRadiusLock', () => {
  const sql = read(MIGRATION);
  const fn = passengerMapFunctionBody(sql);

  it('stores a dedicated, validated radius in global_dispatch_settings (default 25 km)', () => {
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS customer_nearby_drivers_radius_meters integer NOT NULL DEFAULT 25000/,
    );
    expect(sql).toMatch(/CHECK \(customer_nearby_drivers_radius_meters BETWEEN 1000 AND 100000\)/);
  });

  it('passenger_map_nearby_drivers reads the saved radius and ignores the client argument', () => {
    expect(fn).toContain('p_radius_meters double precision DEFAULT NULL');
    expect(fn).toMatch(
      /SELECT gds\.customer_nearby_drivers_radius_meters::double precision\s+FROM public\.global_dispatch_settings gds\s+WHERE gds\.singleton = true/,
    );
    const body = fn.slice(fn.indexOf('AS $function$'));
    expect(body).not.toContain('p_radius_meters');
    expect(body).not.toMatch(/LEAST\(|GREATEST\(|25000/);
  });

  it('keeps freshness/online/eligibility filters by delegating to find_nearby_drivers', () => {
    expect(fn).toContain('FROM public.find_nearby_drivers(');
    expect(fn).toMatch(/p_limit,\s*p_stale_seconds\s*\) f/);
  });

  it('maps output columns by name (no positional SELECT * heading/distance swap)', () => {
    expect(fn).not.toMatch(/SELECT \*|SELECT f\.\*/);
    expect(fn).toMatch(
      /f\.driver_id,\s*f\.lat,\s*f\.lng,\s*f\.distance_meters,\s*f\.speed::real,\s*f\.heading::real,\s*f\.updated_at/,
    );
  });

  it('does not touch dispatch wave radii or towards-destination matching', () => {
    const statements = sql.replace(/--.*$/gm, '');
    expect(statements).not.toMatch(
      /start_radius_meters|expand_radius_meters|max_radius_meters|stacked_search_radius_meters|towards_destination/,
    );
  });

  it('Admin Auto-Dispatch Rules exposes a separate, labelled, unit-aware setting', () => {
    const page = read(PAGE);
    expect(page).toContain('Customer Map — Nearby Drivers Radius');
    expect(page).toContain('customer_nearby_drivers_radius_meters: Math.round(settings.customerNearbyDriversRadiusMeters)');
    expect(page).toContain('const CUSTOMER_NEARBY_RADIUS_DEFAULT_METERS = 25000;');
    expect(page).toContain('const CUSTOMER_NEARBY_RADIUS_MIN_METERS = 1000;');
    expect(page).toContain('const CUSTOMER_NEARBY_RADIUS_MAX_METERS = 100000;');
    expect(page).toContain('Nearby Drivers Radius ({unitShort})');
    expect(page).toMatch(/Customer map nearby drivers radius must be between/);
  });
});
