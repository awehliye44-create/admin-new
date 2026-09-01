import { describe, expect, it } from 'vitest';
import {
  bucketOpenTripsIntoGrid,
  evaluateComputedZonesForServiceArea,
  filterOpenTripsForDemand,
  type TripForDemand,
} from '../../supabase/functions/_shared/computeDriverDemandZones';
import { DEMAND_ZONE_SETTINGS_DEFAULTS } from '../../shared/demandZoneSurgeSSOT';

const SA = 'sa-mk';
const NOW = '2026-09-01T12:00:00.000Z';
const NOW_MS = new Date(NOW).getTime();

function trip(overrides: Partial<TripForDemand> = {}): TripForDemand {
  return {
    id: 'trip-1',
    service_area_id: SA,
    pickup_latitude: 52.04,
    pickup_longitude: -0.76,
    status: 'searching',
    driver_id: null,
    confirmed_driver_id: null,
    created_at: new Date(NOW_MS - 60_000).toISOString(),
    ...overrides,
  };
}

describe('computeDriverDemandZones', () => {
  it('filters open unassigned trips within lifetime', () => {
    const trips = [
      trip(),
      trip({ id: 'old', created_at: new Date(NOW_MS - 10 * 60_000).toISOString() }),
      trip({ id: 'assigned', driver_id: 'driver-1' }),
      trip({ id: 'other-sa', service_area_id: 'sa-other' }),
    ];
    const eligible = filterOpenTripsForDemand(
      trips,
      SA,
      NOW_MS,
      DEMAND_ZONE_SETTINGS_DEFAULTS.open_trip_max_lifetime_minutes,
    );
    expect(eligible).toHaveLength(1);
    expect(eligible[0].id).toBe('trip-1');
  });

  it('proposes levels from saved thresholds and applies hysteresis on recompute', () => {
    const settings = {
      ...DEMAND_ZONE_SETTINGS_DEFAULTS,
      low_min_trips: 1,
      low_max_trips: 2,
      medium_min_trips: 3,
      medium_max_trips: 5,
      high_min_trips: 6,
      consecutive_checks_required: 2,
      zone_radius_meters: 800,
      open_trip_max_lifetime_minutes: 6,
    };

    const sameCellTrips = Array.from({ length: 4 }, (_, i) =>
      trip({ id: `t-${i}`, pickup_latitude: 52.0401, pickup_longitude: -0.7601 }),
    );

    const first = evaluateComputedZonesForServiceArea({
      trips: sameCellTrips,
      settings,
      existingZones: [],
      regionId: 'region-1',
      serviceAreaId: SA,
      evaluatedAtIso: NOW,
    });
    expect(first).toHaveLength(1);
    expect(first[0].proposed_demand_level).toBe('MEDIUM');
    expect(first[0].confirmed_demand_level).toBe('LOW');
    expect(first[0].consecutive_match_count).toBe(1);

    const second = evaluateComputedZonesForServiceArea({
      trips: sameCellTrips,
      settings,
      existingZones: [{
        id: first[0].id!,
        center_lat: first[0].center_lat,
        center_lng: first[0].center_lng,
        proposed_demand_level: first[0].proposed_demand_level,
        confirmed_demand_level: first[0].confirmed_demand_level,
        consecutive_match_count: first[0].consecutive_match_count,
      }],
      regionId: 'region-1',
      serviceAreaId: SA,
      evaluatedAtIso: NOW,
    });
    expect(second[0].confirmed_demand_level).toBe('MEDIUM');
    expect(second[0].demand_level).toBe('MEDIUM');
    expect(second[0].last_open_trip_count).toBe(4);
    expect(second[0].level_changed_at).toBe(NOW);
  });

  it('preserves level_changed_at when confirmed level is unchanged', () => {
    const settings = { ...DEMAND_ZONE_SETTINGS_DEFAULTS, consecutive_checks_required: 2 };
    const priorChangedAt = '2026-08-01T10:00:00.000Z';
    const rows = evaluateComputedZonesForServiceArea({
      trips: [trip()],
      settings,
      existingZones: [{
        id: 'zone-1',
        center_lat: 52.04,
        center_lng: -0.76,
        proposed_demand_level: 'LOW',
        confirmed_demand_level: 'LOW',
        consecutive_match_count: 2,
        level_changed_at: priorChangedAt,
      }],
      regionId: null,
      serviceAreaId: SA,
      evaluatedAtIso: NOW,
    });
    expect(rows[0]?.level_changed_at).toBe(priorChangedAt);
  });

  it('buckets trips into grid cells', () => {
    const cells = bucketOpenTripsIntoGrid(
      [
        { service_area_id: SA, pickup_latitude: 52.04, pickup_longitude: -0.76 },
        { service_area_id: SA, pickup_latitude: 52.0401, pickup_longitude: -0.7601 },
      ],
      SA,
    );
    expect(cells).toHaveLength(1);
    expect(cells[0].open_trip_count).toBe(2);
  });
});
