import type { DemandLevel } from '@/lib/demandZoneMapStyle';
import { DEMAND_ZONE_COLORS } from '@/lib/demandZoneMapStyle';

export interface AdminDemandZone {
  id: string;
  name: string;
  center_lat: number;
  center_lng: number;
  radius_meters: number;
  demand_level: DemandLevel;
  active: boolean;
}

function normalizeLevel(raw: string): DemandLevel {
  const level = raw.trim().toUpperCase();
  if (level === 'HIGH' || level === 'LOW') return level;
  return 'MEDIUM';
}

export function buildDemandZoneCircleRing(
  centerLat: number,
  centerLng: number,
  radiusMeters: number,
  steps = 32,
): Array<[number, number]> {
  const coords: Array<[number, number]> = [];
  const earth = 6_371_000;
  const lat1 = (centerLat * Math.PI) / 180;
  const lng1 = (centerLng * Math.PI) / 180;
  const angDist = radiusMeters / earth;

  for (let i = 0; i <= steps; i += 1) {
    const bearing = (i / steps) * 2 * Math.PI;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angDist)
      + Math.cos(lat1) * Math.sin(angDist) * Math.cos(bearing),
    );
    const lng2 =
      lng1
      + Math.atan2(
        Math.sin(bearing) * Math.sin(angDist) * Math.cos(lat1),
        Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2),
      );
    coords.push([(lng2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }

  return coords;
}

/** Skip null-island / invalid radius so Admin map never paints the ocean. */
export function isValidAdminDemandZoneGeometry(zone: AdminDemandZone): boolean {
  if (!Number.isFinite(zone.center_lat) || !Number.isFinite(zone.center_lng)) {
    return false;
  }
  if (Math.abs(zone.center_lat) > 90 || Math.abs(zone.center_lng) > 180) {
    return false;
  }
  if (zone.center_lat === 0 && zone.center_lng === 0) {
    return false;
  }
  if (!Number.isFinite(zone.radius_meters) || zone.radius_meters <= 0) {
    return false;
  }
  return true;
}

export function buildAdminDemandZonesGeoJson(
  zones: AdminDemandZone[],
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = zones
    .filter((zone) => zone.active && isValidAdminDemandZoneGeometry(zone))
    .map((zone) => {
      const level = normalizeLevel(zone.demand_level);
      const colors = DEMAND_ZONE_COLORS[level];
      const ring = buildDemandZoneCircleRing(zone.center_lat, zone.center_lng, zone.radius_meters);

      return {
        type: 'Feature',
        id: zone.id,
        properties: {
          id: zone.id,
          name: zone.name,
          demand_level: level,
          fillColor: colors.fill,
          strokeColor: colors.stroke,
          fillOpacity: colors.fillOpacity,
          strokeOpacity: colors.strokeOpacity,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [ring],
        },
      };
    });

  return { type: 'FeatureCollection', features };
}
