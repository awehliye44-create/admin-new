/**
 * LOCK MK-260926-004: SQL wave-1 online gate must match Edge auto-dispatch.
 * Intent-online + cleared is_online (expire_stale / iOS BG GPS gap) must still
 * receive trip_insert offers. Never require BOTH flags.
 * If this fails, fix the code — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const MIGRATION =
  'supabase/migrations/20261203120000_dispatch_online_gate_intent_or_is_online_mk260926004.sql';

describe('dispatchOnlineGateMk260926004Lock', () => {
  it('ships helper: is_online OR intent, fail closed on explicit offline', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.driver_passes_dispatch_online_availability_gate',
    );
    expect(sql).toMatch(
      /NOT public\.is_explicit_offline_reason\(p_offline_reason\)[\s\S]*COALESCE\(p_is_online, false\)[\s\S]*OR[\s\S]*COALESCE\(p_driver_online_intent, false\)/,
    );
    expect(sql).not.toMatch(
      /COALESCE\(p_is_online,\s*false\)\s*AND\s*COALESCE\(p_driver_online_intent/,
    );
  });

  it('text overload uses helper — never AND both is_online and intent', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.dispatch_trip_offers(p_trip_id uuid, p_trigger_reason text',
    );
    expect(sql).toContain(
      'public.driver_passes_dispatch_online_availability_gate(\n            d.is_online, d.driver_online_intent, dp.offline_reason)',
    );
    expect(sql).not.toMatch(
      /d\.is_online\s*=\s*true\s+AND\s+COALESCE\(d\.driver_online_intent,\s*false\)\s*=\s*true/,
    );
    // Dollar-quote must open and close (db push 42601 if closer missing).
    expect((sql.match(/\$function\$/g) ?? []).length).toBe(2);
  });

  it('Edge auto-dispatch keeps OR online gate (parity target)', () => {
    const edge = read('supabase/functions/auto-dispatch/index.ts');
    expect(edge).toContain(
      'const backendAvailabilityOnline = d.is_online === true || (driverOnlineIntent && !explicitOffline);',
    );
    expect(edge).not.toMatch(
      /d\.is_online\s*===\s*true\s*&&\s*driverOnlineIntent/,
    );
  });
});
