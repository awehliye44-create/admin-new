import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('demand zone booking surge lock', () => {
  it('calculate-fare disables legacy enable_surge and applies zone surge SSOT', () => {
    const src = read('supabase/functions/calculate-fare/index.ts');
    expect(src).toContain('enable_surge: false');
    expect(src).toContain('resolve_zone_surge');
    expect(src).toContain('applyZoneSurgeToMeteredFarePence');
    expect(src).toContain('surge_quote: surgeQuote');
  });

  it('create-trip-after-payment re-validates surge at booking via assertBookingSurgeAtPickup', () => {
    const src = read('supabase/functions/create-trip-after-payment/index.ts');
    expect(src).toContain('assertBookingSurgeAtPickup');
    expect(src).toContain('surgeQuote: body.surge_quote');
    expect(src).toContain('surgeMultiplier: surgeCheck.multiplier');
    expect(src).toContain('code: surgeCheck.code');
    expect(src).toContain('failure_stage: "surge_quote"');
  });

  it('create-ride legacy path uses the same booking surge assertion', () => {
    const src = read('supabase/functions/create-ride/index.ts');
    expect(src).toContain('assertBookingSurgeAtPickup');
    expect(src).toContain('surgeQuote: payload.surge_quote');
  });

  it('estimate-fare resolves pickup zone surge outside the fare engine', () => {
    const src = read('supabase/functions/estimate-fare/index.ts');
    expect(src).toContain('resolve_zone_surge');
    expect(src).toContain('zone_surge_multiplier: 1');
    expect(src).toContain('parseRpcSurgeResolution');
    expect(src).toContain('surge_quote: q.surgeQuote');
  });

  it('demand zones RBAC migration seeds page access and staff policies', () => {
    const src = read('supabase/migrations/20261028200000_demand_zones_rbac_and_page_seed.sql');
    expect(src).toContain("'driver-demand-zones'");
    expect(src).toContain('Staff view demand zones');
    expect(src).toContain("staff_has_action(auth.uid(), 'demand_zones.view')");
  });

  it('roles SSOT exposes demand zone action keys for the permissions matrix', () => {
    const src = read('shared/rolesPermissionsSSOT.ts');
    expect(src).toContain('DEMAND_ZONE_ROLE_ACTION_KEYS');
    expect(src).toContain("'demand_zones.configure_surge'");
    expect(src).toContain('DEMAND_ZONE_ACTION_LABELS');
  });

  it('Roles page renders demand zone action capability matrix', () => {
    const src = read('src/pages/RolesPermissions.tsx');
    expect(src).toContain('DEMAND_ZONE_ROLE_ACTION_KEYS');
    expect(src).toContain('Driver Demand Zones — Action Capabilities');
    expect(src).toContain('handleToggleActionPermission');
  });

  it('compute-driver-demand-zones requires cron/service-role or demand_zones.recompute', () => {
    const src = read('supabase/functions/compute-driver-demand-zones/index.ts');
    expect(src).toContain('requireDemandZoneRecomputeAuth');
  });

  it('surge hardening migration gates resolve_zone_surge on heat_map_enabled', () => {
    const src = read('supabase/migrations/20261028210000_demand_zones_surge_hardening.sql');
    expect(src).toContain('HEAT_MAP_DISABLED');
    expect(src).toContain('manual_zones_enabled = true');
    expect(src).toContain('REVOKE INSERT, UPDATE, DELETE');
  });
});
