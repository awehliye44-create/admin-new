import { describe, it, expect } from 'vitest';
import {
  ALL_SERVICE_AREAS,
  DEMAND_ZONE_ACTION_KEYS,
  DEMAND_ZONE_SETTINGS_DEFAULTS,
  applyHysteresis,
  applyZoneSurgeToMeteredFarePence,
  buildSurgeQuote,
  canConfigureForSelection,
  countOpenTrips,
  isValidHexColour,
  levelColour,
  lockedBookingMultiplier,
  meteredFareEligibleForZoneSurge,
  normaliseHexColour,
  proposeLevel,
  quoteRequiresRefresh,
  resolveZoneSurge,
  validateBookingSurgeQuote,
  validateColours,
  validateDemandZoneSettings,
  validateSurge,
  validateThresholds,
  type DemandZoneSettings,
  type SurgeZone,
} from '../../shared/demandZoneSurgeSSOT';

const SA_MK = 'sa-milton-keynes';
const SA_LU = 'sa-luton';

function settings(overrides: Partial<DemandZoneSettings> = {}): DemandZoneSettings {
  return {
    service_area_id: SA_MK,
    ...DEMAND_ZONE_SETTINGS_DEFAULTS,
    ...overrides,
  } as DemandZoneSettings;
}

function zone(overrides: Partial<SurgeZone> = {}): SurgeZone {
  return {
    id: 'zone-central',
    service_area_id: SA_MK,
    active: true,
    source: 'computed',
    center_lat: 52.0406,
    center_lng: -0.7594,
    radius_meters: 700,
    confirmed_demand_level: 'HIGH',
    ...overrides,
  };
}

describe('per-service-area isolation', () => {
  const mk = settings({ service_area_id: SA_MK, high_min_trips: 6, medium_min_trips: 3, medium_max_trips: 5, colour_high: '#EF4444', surge_enabled: true, multiplier_medium: 1.1, multiplier_high: 1.25 });
  const lu = settings({ service_area_id: SA_LU, low_max_trips: 5, medium_min_trips: 6, medium_max_trips: 9, high_min_trips: 10, colour_high: '#111111', surge_enabled: true, multiplier_medium: 1.5, multiplier_high: 1.8 });

  it('thresholds do not leak between service areas', () => {
    expect(proposeLevel(6, mk)).toBe('HIGH');
    expect(proposeLevel(6, lu)).toBe('MEDIUM');
  });

  it('colours do not leak between service areas', () => {
    expect(levelColour(mk, 'HIGH')).toBe('#EF4444');
    expect(levelColour(lu, 'HIGH')).toBe('#111111');
  });

  it('multipliers do not leak between service areas', () => {
    const zones = [zone({ service_area_id: SA_MK }), zone({ id: 'lu-zone', service_area_id: SA_LU })];
    const mkRes = resolveZoneSurge({ zones, settings: mk, serviceAreaId: SA_MK, pickupLat: 52.0406, pickupLng: -0.7594 });
    const luRes = resolveZoneSurge({ zones, settings: lu, serviceAreaId: SA_LU, pickupLat: 52.0406, pickupLng: -0.7594 });
    expect(mkRes.applied_multiplier).toBe(1.25);
    expect(luRes.applied_multiplier).toBe(1.8);
  });
});

describe('threshold validation', () => {
  it('accepts contiguous ranges', () => {
    expect(validateThresholds(settings()).valid).toBe(true);
  });
  it('rejects overlapping ranges', () => {
    const r = validateThresholds(settings({ medium_min_trips: 2 }));
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('MEDIUM_MIN_NOT_GT_LOW_MAX');
  });
  it('rejects gaps between ranges', () => {
    expect(validateThresholds(settings({ high_min_trips: 8 })).errors).toContain('GAP_BETWEEN_MEDIUM_AND_HIGH');
  });
  it('rejects negative low minimum', () => {
    expect(validateThresholds(settings({ low_min_trips: -1 })).errors).toContain('LOW_MIN_INVALID');
  });
});

describe('colour validation', () => {
  it('accepts six-digit hex and normalises', () => {
    expect(isValidHexColour('#ab12cd')).toBe(true);
    expect(normaliseHexColour('ab12cd')).toBe('#AB12CD');
  });
  it('rejects invalid hex', () => {
    expect(isValidHexColour('#GGGGGG')).toBe(false);
    expect(isValidHexColour('#FFF')).toBe(false);
    expect(validateColours(settings({ colour_low: 'red' } as never)).errors).toContain('COLOUR_LOW_INVALID');
  });
  it('colour changes never change pricing', () => {
    const base = settings({ surge_enabled: true, multiplier_medium: 1.1, multiplier_high: 1.25 });
    const recoloured = { ...base, colour_high: '#000000', colour_low: '#FFFFFF' };
    const zones = [zone()];
    const a = resolveZoneSurge({ zones, settings: base, serviceAreaId: SA_MK, pickupLat: 52.0406, pickupLng: -0.7594 });
    const b = resolveZoneSurge({ zones, settings: recoloured, serviceAreaId: SA_MK, pickupLat: 52.0406, pickupLng: -0.7594 });
    expect(b.applied_multiplier).toBe(a.applied_multiplier);
  });
});

describe('surge validation', () => {
  it('rejects multiplier below 1.00', () => {
    expect(validateSurge(settings({ surge_enabled: true, multiplier_medium: 0.9, multiplier_high: 1.2 })).errors)
      .toContain('MULTIPLIER_MEDIUM_BELOW_ONE');
  });
  it('rejects multiplier above the service-area maximum', () => {
    expect(validateSurge(settings({ surge_enabled: true, max_multiplier: 1.2, multiplier_medium: 1.1, multiplier_high: 1.5 })).errors)
      .toContain('MULTIPLIER_HIGH_ABOVE_MAX');
  });
  it('rejects out-of-order multipliers', () => {
    expect(validateSurge(settings({ surge_enabled: true, multiplier_medium: 1.3, multiplier_high: 1.1 })).errors)
      .toContain('HIGH_LT_MEDIUM');
  });
  it('cannot enable surge without medium and high multipliers', () => {
    const r = validateSurge(settings({ surge_enabled: true }));
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('MULTIPLIER_MEDIUM_REQUIRED');
  });
  it('defaults are valid while surge is disabled', () => {
    expect(validateDemandZoneSettings(settings()).valid).toBe(true);
  });
});

describe('open trip counting', () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0);
  const at = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();

  it('counts an open unassigned trip immediately', () => {
    expect(countOpenTrips([{ trip_id: 't1', status: 'pending', driver_id: null, created_at: at(0) }], now, 6)).toBe(1);
  });
  it('removes assigned trips', () => {
    expect(countOpenTrips([{ trip_id: 't1', status: 'accepted', driver_id: 'd1', created_at: at(1) }], now, 6)).toBe(0);
  });
  it('removes cancelled trips', () => {
    expect(countOpenTrips([{ trip_id: 't1', status: 'cancelled', driver_id: null, created_at: at(1) }], now, 6)).toBe(0);
  });
  it('removes trips past the configured lifetime', () => {
    const trips = [{ trip_id: 't1', status: 'searching', driver_id: null, created_at: at(7) }];
    expect(countOpenTrips(trips, now, 6)).toBe(0);
    expect(countOpenTrips(trips, now, 10)).toBe(1);
  });
  it('counts a trip offered to many drivers only once', () => {
    const trips = [
      { trip_id: 't1', status: 'offered', driver_id: null, created_at: at(1) },
      { trip_id: 't1', status: 'offered', driver_id: null, created_at: at(1) },
      { trip_id: 't1', status: 'offered', driver_id: null, created_at: at(1) },
    ];
    expect(countOpenTrips(trips, now, 6)).toBe(1);
  });
});

describe('hysteresis', () => {
  const required = 2;
  it('first HIGH reading does not confirm', () => {
    const r = applyHysteresis({ proposed_demand_level: null, confirmed_demand_level: 'LOW', consecutive_match_count: 0 }, 'HIGH', required);
    expect(r.confirmed_demand_level).toBe('LOW');
    expect(r.consecutive_match_count).toBe(1);
    expect(r.changed).toBe(false);
  });
  it('second matching reading confirms', () => {
    const first = applyHysteresis({ proposed_demand_level: null, confirmed_demand_level: 'LOW', consecutive_match_count: 0 }, 'HIGH', required);
    const second = applyHysteresis(first, 'HIGH', required);
    expect(second.confirmed_demand_level).toBe('HIGH');
    expect(second.changed).toBe(true);
  });
  it('resets the count when the proposed level changes', () => {
    const first = applyHysteresis({ proposed_demand_level: null, confirmed_demand_level: 'LOW', consecutive_match_count: 0 }, 'HIGH', required);
    const flip = applyHysteresis(first, 'MEDIUM', required);
    expect(flip.consecutive_match_count).toBe(1);
    expect(flip.confirmed_demand_level).toBe('LOW');
  });
  it('returning to LOW also requires the configured consecutive checks', () => {
    let state = { proposed_demand_level: 'HIGH' as const, confirmed_demand_level: 'HIGH' as const, consecutive_match_count: 0 };
    const first = applyHysteresis(state, 'LOW', required);
    expect(first.confirmed_demand_level).toBe('HIGH');
    const second = applyHysteresis(first, 'LOW', required);
    expect(second.confirmed_demand_level).toBe('LOW');
  });
});

describe('zone-based surge resolution', () => {
  const s = settings({ surge_enabled: true, multiplier_medium: 1.1, multiplier_high: 1.25 });

  it('pickup inside a HIGH zone gets the configured HIGH multiplier', () => {
    const r = resolveZoneSurge({ zones: [zone()], settings: s, serviceAreaId: SA_MK, pickupLat: 52.0406, pickupLng: -0.7594 });
    expect(r.applied_multiplier).toBe(1.25);
    expect(r.zone_id).toBe('zone-central');
  });

  it('pickup outside any active zone gets 1.00', () => {
    const r = resolveZoneSurge({ zones: [zone()], settings: s, serviceAreaId: SA_MK, pickupLat: 52.2, pickupLng: -0.9 });
    expect(r.applied_multiplier).toBe(1);
    expect(r.reason).toBe('NO_ZONE');
  });

  it('another part of the same service area is unaffected by a busy zone', () => {
    const zones = [zone(), zone({ id: 'tattenhoe', center_lat: 52.0, center_lng: -0.8, confirmed_demand_level: 'LOW' })];
    const r = resolveZoneSurge({ zones, settings: s, serviceAreaId: SA_MK, pickupLat: 52.0, pickupLng: -0.8 });
    expect(r.zone_id).toBe('tattenhoe');
    expect(r.applied_multiplier).toBe(1);
  });

  it('surge disabled always yields 1.00 even in a HIGH zone', () => {
    const r = resolveZoneSurge({ zones: [zone()], settings: settings({ surge_enabled: false }), serviceAreaId: SA_MK, pickupLat: 52.0406, pickupLng: -0.7594 });
    expect(r.applied_multiplier).toBe(1);
    expect(r.confirmed_demand_level).toBe('HIGH');
    expect(r.reason).toBe('SURGE_DISABLED');
  });

  it('manual zones never price', () => {
    const r = resolveZoneSurge({ zones: [zone({ source: 'manual' })], settings: s, serviceAreaId: SA_MK, pickupLat: 52.0406, pickupLng: -0.7594 });
    expect(r.applied_multiplier).toBe(1);
    expect(r.reason).toBe('NO_ZONE');
  });

  it('inactive zones never price', () => {
    const r = resolveZoneSurge({ zones: [zone({ active: false })], settings: s, serviceAreaId: SA_MK, pickupLat: 52.0406, pickupLng: -0.7594 });
    expect(r.applied_multiplier).toBe(1);
  });
});

describe('quote lock', () => {
  const s = settings({ surge_enabled: true, multiplier_medium: 1.1, multiplier_high: 1.25 });
  const now = Date.UTC(2026, 7, 3, 12, 0, 0);
  const zones = [zone(), zone({ id: 'tattenhoe', center_lat: 52.0, center_lng: -0.8, confirmed_demand_level: 'LOW' })];
  const resolution = resolveZoneSurge({ zones, settings: s, serviceAreaId: SA_MK, pickupLat: 52.0406, pickupLng: -0.7594 });
  const quote = buildSurgeQuote({
    quoteId: 'q1', serviceAreaId: SA_MK, baseFarePence: 1000, resolution,
    pickupLat: 52.0406, pickupLng: -0.7594, issuedAtMs: now, ttlSeconds: 300,
  });

  it('returns structured surge data', () => {
    expect(quote.base_fare_before_surge_pence).toBe(1000);
    expect(quote.applied_multiplier).toBe(1.25);
    expect(quote.surge_amount_pence).toBe(250);
    expect(quote.final_fare_pence).toBe(1250);
    expect(quote.zone_id).toBe('zone-central');
    expect(quote.confirmed_demand_level).toBe('HIGH');
  });

  it('moving the pickup to another zone requires a refreshed quote', () => {
    expect(quoteRequiresRefresh(quote, { lat: 52.0, lng: -0.8 }, now + 1000, zones)).toBe(true);
    expect(quoteRequiresRefresh(quote, { lat: 52.0406, lng: -0.7594 }, now + 1000, zones)).toBe(false);
  });

  it('expired quotes require refresh', () => {
    expect(quoteRequiresRefresh(quote, { lat: 52.0406, lng: -0.7594 }, now + 400_000, zones)).toBe(true);
  });

  it('confirmed booking keeps its locked multiplier and ignores client input', () => {
    expect(lockedBookingMultiplier(quote, 9.99)).toBe(1.25);
  });
});

describe('calculate-fare zone surge helpers', () => {
  it('only standard dynamic metered fares are surge eligible', () => {
    expect(meteredFareEligibleForZoneSurge('standard_dynamic', 'NORMAL_DISTANCE_TIME')).toBe(true);
    expect(meteredFareEligibleForZoneSurge('route_fixed', 'ROUTE_PRICING')).toBe(false);
  });

  it('applies zone multiplier to trip fare and preserves airport add-on', () => {
    const resolution = resolveZoneSurge({
      zones: [zone()],
      settings: settings({ surge_enabled: true, multiplier_high: 1.25 }),
      serviceAreaId: SA_MK,
      pickupLat: 52.0406,
      pickupLng: -0.7594,
    });
    const result = applyZoneSurgeToMeteredFarePence({
      tripFarePence: 800,
      airportChargePence: 200,
      surgeResolution: resolution,
      serviceAreaId: SA_MK,
      pickupLat: 52.0406,
      pickupLng: -0.7594,
      issuedAtMs: Date.now(),
    });
    expect(result.appliedMultiplier).toBe(1.25);
    expect(result.finalFarePence).toBe(1200);
    expect(result.surgeQuote.applied_multiplier).toBe(1.25);
  });

  it('validateBookingSurgeQuote rejects stale multipliers', () => {
    const stale = validateBookingSurgeQuote(
      {
        quote_id: 'q1',
        service_area_id: SA_MK,
        zone_id: 'zone-central',
        confirmed_demand_level: 'HIGH',
        applied_multiplier: 1.5,
        quote_expires_at: new Date(Date.now() + 60_000).toISOString(),
        pickup_lat: 52.0406,
        pickup_lng: -0.7594,
      },
      1.25,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('SURGE_QUOTE_STALE');
  });
});

describe('permissions and all-areas mode', () => {
  it('all service areas mode blocks configuration even for super admin', () => {
    expect(canConfigureForSelection({
      selectedServiceAreaId: ALL_SERVICE_AREAS,
      isSuperAdmin: true,
      allowedActions: [],
      actionKey: DEMAND_ZONE_ACTION_KEYS.configureSurge,
    })).toBe(false);
  });

  it('staff without the action key cannot configure', () => {
    expect(canConfigureForSelection({
      selectedServiceAreaId: SA_MK,
      isSuperAdmin: false,
      allowedActions: [DEMAND_ZONE_ACTION_KEYS.view],
      actionKey: DEMAND_ZONE_ACTION_KEYS.configureSurge,
    })).toBe(false);
  });

  it('staff with the action key can configure a single service area', () => {
    expect(canConfigureForSelection({
      selectedServiceAreaId: SA_MK,
      isSuperAdmin: false,
      allowedActions: [DEMAND_ZONE_ACTION_KEYS.configureHeatMap],
      actionKey: DEMAND_ZONE_ACTION_KEYS.configureHeatMap,
    })).toBe(true);
  });
});
