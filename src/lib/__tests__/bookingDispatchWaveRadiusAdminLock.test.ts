/**
 * Lock: booking dispatch wave radii are Admin-owned (Auto-Dispatch Rules →
 * global_dispatch_settings start/expand/max_radius_meters = absolute Wave 1/2/3)
 * and both dispatch paths use them with no hidden radius.
 *
 * Edge auto-dispatch used start + expand, so Admin 13/17/29 km ran Wave 2 at
 * 29 km while Admin showed 17 km.
 * If this fails, fix the code — never delete or soften the lock.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  BOOKING_DISPATCH_WAVE_RADIUS_DEFAULTS_METERS,
  bookingDispatchRadiusForWave,
  bookingDispatchWaveRadiiFromRow,
  validateBookingDispatchWaveRadii,
} from '../../../shared/bookingDispatchRadiusSSOT';

const ROOT = path.join(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripSqlComments = (sql: string) => sql.replace(/--.*$/gm, '');

const PAGE = read('src/pages/AutoDispatchRules.tsx');
const SETTINGS = read('supabase/functions/_shared/dispatch-settings.ts');
const AUTO_DISPATCH = read('supabase/functions/auto-dispatch/index.ts');
const ORCHESTRATOR = read('supabase/functions/_shared/dispatchOrchestrator.ts');
const MIGRATION = read('supabase/migrations/20261204140000_booking_dispatch_wave_radius_admin_ssot.sql');

describe('bookingDispatchRadiusSSOT', () => {
  it('accepts the live values and preserves them as defaults', () => {
    expect(BOOKING_DISPATCH_WAVE_RADIUS_DEFAULTS_METERS).toEqual({ wave1: 13000, wave2: 17000, wave3: 29000 });
    expect(validateBookingDispatchWaveRadii(BOOKING_DISPATCH_WAVE_RADIUS_DEFAULTS_METERS)).toEqual([]);
  });

  it('rejects blank, out-of-range and decreasing radii', () => {
    const codes = (r: { wave1: number; wave2: number; wave3: number }) =>
      validateBookingDispatchWaveRadii(r).map((i) => `${i.field}:${i.code}`);
    expect(codes({ wave1: Number.NaN, wave2: 17000, wave3: 29000 })).toEqual(['wave1:required']);
    expect(codes({ wave1: 499, wave2: 17000, wave3: 29000 })).toEqual(['wave1:out_of_range']);
    expect(codes({ wave1: 13000, wave2: 17000, wave3: 100001 })).toEqual(['wave3:out_of_range']);
    expect(codes({ wave1: 13000, wave2: 12000, wave3: 29000 })).toEqual(['wave2:not_increasing']);
    expect(codes({ wave1: 13000, wave2: 17000, wave3: 16000 })).toEqual(['wave3:not_increasing']);
    expect(codes({ wave1: 500, wave2: 500, wave3: 100000 })).toEqual([]);
  });

  it('per-wave radius is absolute (never start + expand) and capped at Wave 3', () => {
    const radii = bookingDispatchWaveRadiiFromRow({
      start_radius_meters: 13000,
      expand_radius_meters: 17000,
      max_radius_meters: 29000,
    })!;
    expect([1, 2, 3].map((w) => bookingDispatchRadiusForWave(radii, w as 1 | 2 | 3))).toEqual([13000, 17000, 29000]);
    expect(bookingDispatchWaveRadiiFromRow({ start_radius_meters: 13000, expand_radius_meters: null, max_radius_meters: 29000 })).toBeNull();
  });
});

describe('Admin Auto-Dispatch Rules page', () => {
  it('exposes labelled, unit-aware Wave 1/2/3 radius controls bound to the Admin columns', () => {
    for (const label of ['Wave 1 Radius', 'Wave 2 Radius', 'Wave 3 Radius']) expect(PAGE).toContain(label);
    expect(PAGE).toContain('Booking Dispatch Radius per Wave ({unitShort})');
    expect(PAGE).toContain('...bookingDispatchWaveRadiiToRow(bookingWaveRadii(settings))');
    expect(PAGE).toContain('bookingWave1RadiusMeters: metersOrNaN(data.start_radius_meters)');
    expect(PAGE).toContain('bookingWave2RadiusMeters: metersOrNaN(data.expand_radius_meters)');
    expect(PAGE).toContain('bookingWave3RadiusMeters: metersOrNaN(data.max_radius_meters)');
  });

  it('has no hidden radius fallbacks on load or input', () => {
    expect(PAGE).not.toMatch(/searchRadius(Start|Expand|Max)Km/);
    expect(PAGE).not.toMatch(/_radius_meters \?\? \d/);
    expect(PAGE).not.toMatch(/\|\| fromKm\(\d/);
  });

  it('validates before save, reads back what Postgres stored, and can reload', () => {
    const save = PAGE.slice(PAGE.indexOf('const handleSave'), PAGE.indexOf('return (\n    <AdminLayout'));
    expect(save.indexOf('waveRadiusIssues.length > 0')).toBeGreaterThan(-1);
    expect(save.indexOf('waveRadiusIssues.length > 0')).toBeLessThan(save.indexOf('.update(dbData)'));
    expect(save).toMatch(/\.update\(dbData\)\s*\.eq\('singleton', true\)\s*\.select\(GLOBAL_DISPATCH_SETTINGS_SELECT\)\s*\.single\(\)/);
    expect(save).toContain("throw new Error('Booking dispatch radius did not persist')");
    expect(save).toContain('setSettings(savedSettings)');
    expect(PAGE).toContain('onClick={handleReload}');
    expect(PAGE).toMatch(/const handleReload = async \(\) => \{[\s\S]*?await loadDispatchSettings\(\);/);
  });

  it('keeps the Customer map radius out of the wave radius controls', () => {
    const radiusBlock = PAGE.slice(
      PAGE.indexOf('Booking Dispatch Radius per Wave ({unitShort})'),
      PAGE.indexOf('{/* Wave Sizes */}'),
    );
    expect(radiusBlock).not.toMatch(/customerNearby|CUSTOMER_NEARBY/);
  });
});

describe('Edge dispatch reads Admin wave radii only', () => {
  it('dispatch-settings has no schema-default or per-area km radius path', () => {
    const defaults = SETTINGS.slice(
      SETTINGS.indexOf('export const DISPATCH_SETTINGS_SCHEMA_DEFAULTS'),
      SETTINGS.indexOf('export type DispatchSettingsSource'),
    );
    expect(defaults).not.toMatch(/(?<![a-z_])search_radius_(meters|start_km|expand_km|max_km)/);
    expect(SETTINGS).not.toMatch(/settings\.search_radius_(meters|start_km|expand_km|max_km)/);
    expect(SETTINGS).not.toMatch(/startM \+ \(wave - 1\) \* expandM/);
    expect(SETTINGS).toContain('bookingDispatchRadiusForWave(');
    expect(SETTINGS).toContain('throw new BookingDispatchRadiusConfigError(');
    expect(SETTINGS).not.toMatch(/customer_nearby/);
  });

  it('towards-destination uses its own column, not a wave radius', () => {
    const fn = SETTINGS.slice(SETTINGS.indexOf('export function destinationMatchRadiusMeters'));
    expect(fn.slice(0, 400)).toContain('settings.towards_destination_match_radius_meters');
    expect(SETTINGS).toMatch(/"towards_destination_match_radius_meters",\s*\] as const;/);
  });

  it('auto-dispatch filters on the per-sequence Admin radius with no literal radius', () => {
    expect(AUTO_DISPATCH).toContain('effectiveRadiusM = effectiveRadiusMeters(dispatchSettings, currentRound);');
    expect(AUTO_DISPATCH).toContain('if (dist > effectiveRadiusM)');
    expect(AUTO_DISPATCH).toContain('.filter(d => d.distance_meters! <= effectiveRadiusM)');
    expect(AUTO_DISPATCH).not.toMatch(/let (startRadiusM|maxRadiusM|effectiveRadiusM) = [1-9]/);
    expect(AUTO_DISPATCH).not.toMatch(/customer_nearby/);
  });

  it('the emergency SQL RPC names p_trigger_reason so only the Admin-driven overload matches', () => {
    expect(ORCHESTRATOR).toMatch(/rpc\("dispatch_trip_offers", \{\s*p_trip_id: tripId,\s*p_trigger_reason: /);
  });
});

describe('SQL dispatcher + migration', () => {
  it('latest dispatch_trip_offers(uuid, text) maps Wave 1/2/3 to start/expand/max absolutely', () => {
    const dir = path.join(ROOT, 'supabase/migrations');
    const marker = 'CREATE OR REPLACE FUNCTION public.dispatch_trip_offers(p_trip_id uuid, p_trigger_reason text';
    const latest = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes(marker)).pop()!;
    const body = fs.readFileSync(path.join(dir, latest), 'utf8');
    expect(body).toMatch(/WHEN 1 THEN[^\n]*\n[^\n]*v_radius := v_g\.start_radius_meters;/);
    expect(body).toMatch(/WHEN 2 THEN[^\n]*\n[^\n]*v_radius := v_g\.expand_radius_meters;/);
    expect(body).toMatch(/ELSE[^\n]*\n[^\n]*v_radius := v_g\.max_radius_meters;/);
    expect(body).toContain('v_radius := LEAST(v_radius, COALESCE(v_max_radius, v_radius));');
  });

  it('migration documents, bounds and separates without changing live values', () => {
    const sql = stripSqlComments(MIGRATION);
    expect(sql).toMatch(/expand_radius_meters IS\s+'Booking dispatch Wave 2 radius[^']*NOT an increment/);
    expect(sql).toContain('CHECK (start_radius_meters >= 500 AND max_radius_meters <= 100000)');
    expect(sql).toMatch(/SET towards_destination_match_radius_meters = start_radius_meters/);
    expect(sql).toContain('CHECK (towards_destination_match_radius_meters BETWEEN 500 AND 100000)');
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.dispatch_trip_offers\(uuid\) FROM PUBLIC, anon, authenticated, service_role/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.dispatch_trip_offers\(uuid, boolean\) FROM PUBLIC, anon, authenticated, service_role/);
    expect(sql).not.toMatch(/UPDATE[^;]*SET\s+(start|expand|max)_radius_meters/);
    expect(sql).not.toMatch(/customer_nearby|stacked_search_radius_meters/);
  });
});
