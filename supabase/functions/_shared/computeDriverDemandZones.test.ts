import {
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  bucketOpenTripsIntoGrid,
  buildComputedDemandZoneRows,
  demandLevelFromOpenCount,
} from './computeDriverDemandZones.ts';

Deno.test('null-island pickups are ignored', () => {
  const cells = bucketOpenTripsIntoGrid([
    { service_area_id: 'sa1', pickup_latitude: 0, pickup_longitude: 0 },
    { service_area_id: 'sa1', pickup_latitude: 52.04, pickup_longitude: -0.76 },
  ]);
  assertEquals(cells.length, 1);
  assertEquals(cells[0]?.open_trip_count, 1);
});

Deno.test('open-trip counts map to existing demand levels', () => {
  assertEquals(demandLevelFromOpenCount(1), 'LOW');
  assertEquals(demandLevelFromOpenCount(2), 'MEDIUM');
  assertEquals(demandLevelFromOpenCount(4), 'HIGH');
});

Deno.test('computed rows include service area and stay active', () => {
  const region = new Map<string, string | null>([['sa1', 'reg1']]);
  const rows = buildComputedDemandZoneRows(
    [{
      service_area_id: 'sa1',
      center_lat: 52.04,
      center_lng: -0.76,
      open_trip_count: 2,
    }],
    region,
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0]?.source, 'computed');
  assertEquals(rows[0]?.active, true);
  assertEquals(rows[0]?.service_area_id, 'sa1');
  assertEquals(rows[0]?.region_id, 'reg1');
  assertEquals(rows[0]?.demand_level, 'MEDIUM');
});
