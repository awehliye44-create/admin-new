import { describe, expect, it } from 'vitest';
import {
  buildAdminDemandZonesGeoJson,
  isValidAdminDemandZoneGeometry,
  type AdminDemandZone,
} from '@/lib/demandZoneGeojson';

const base: AdminDemandZone = {
  id: 'z1',
  name: 'MK',
  center_lat: 52.04,
  center_lng: -0.76,
  radius_meters: 700,
  demand_level: 'MEDIUM',
  active: true,
};

describe('demandZoneGeojson auto-visibility guards', () => {
  it('accepts real UK centres', () => {
    expect(isValidAdminDemandZoneGeometry(base)).toBe(true);
  });

  it('rejects null-island so Admin never paints ocean', () => {
    expect(
      isValidAdminDemandZoneGeometry({
        ...base,
        center_lat: 0,
        center_lng: 0,
      }),
    ).toBe(false);
  });

  it('skips invalid and inactive zones when building GeoJSON', () => {
    const geo = buildAdminDemandZonesGeoJson([
      base,
      { ...base, id: 'bad', center_lat: 0, center_lng: 0 },
      { ...base, id: 'off', active: false },
    ]);
    expect(geo.features).toHaveLength(1);
    expect(geo.features[0]?.id).toBe('z1');
  });
});
