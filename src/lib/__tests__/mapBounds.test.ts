import { describe, expect, it } from 'vitest';
import {
  boundsFromPositions,
  buildDemandZonesBounds,
  collectDriverMapPositions,
  isValidUkCoord,
} from '@/lib/mapBounds';
import type { AdminDemandZone } from '@/lib/demandZoneGeojson';

describe('mapBounds', () => {
  it('accepts UK coordinates and rejects swapped/null island', () => {
    expect(isValidUkCoord(-0.76, 52.04)).toBe(true);
    expect(isValidUkCoord(-0.1278, 51.5074)).toBe(true);
    expect(isValidUkCoord(52.04, -0.76)).toBe(false);
    expect(isValidUkCoord(0, 0)).toBe(false);
  });

  it('builds bounds that include full demand zone radius', () => {
    const zones: AdminDemandZone[] = [{
      id: 'z1',
      name: 'MK Central',
      center_lat: 52.04,
      center_lng: -0.76,
      radius_meters: 1200,
      demand_level: 'HIGH',
      active: true,
    }];

    const bounds = buildDemandZonesBounds(zones, null);
    expect(bounds).not.toBeNull();
    const sw = bounds!.getSouthWest();
    const ne = bounds!.getNorthEast();
    expect(ne.lat - sw.lat).toBeGreaterThan(0.01);
    expect(ne.lng - sw.lng).toBeGreaterThan(0.01);
  });

  it('collects live GPS positions across UK cities', () => {
    const positions = collectDriverMapPositions(
      [
        { current_lat: 52.04, current_lng: -0.76, region_id: 'mk' },
        { current_lat: 51.5074, current_lng: -0.1278, region_id: 'ldn' },
      ],
      [],
    );
    expect(positions).toHaveLength(2);
    const bounds = boundsFromPositions(positions);
    expect(bounds).not.toBeNull();
    const sw = bounds!.getSouthWest();
    const ne = bounds!.getNorthEast();
    expect(sw.lat).toBeLessThan(51.6);
    expect(ne.lat).toBeGreaterThan(51.9);
    expect(sw.lng).toBeLessThan(-0.2);
    expect(ne.lng).toBeGreaterThan(-0.8);
  });
});
