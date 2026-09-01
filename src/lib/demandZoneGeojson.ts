import type { DemandLevel } from '@/lib/demandZoneMapStyle';
import {
  buildDemandZoneColorPalette,
  DEMAND_ZONE_COLORS,
  type DemandZoneColorEntry,
} from '@/lib/demandZoneMapStyle';
import type { DemandZoneSettings } from '../../shared/demandZoneSurgeSSOT';

export interface AdminDemandZone {
  id: string;
  name: string;
  center_lat: number;
  center_lng: number;
  radius_meters: number;
  demand_level: DemandLevel;
  active: boolean;
  service_area_id?: string | null;
  confirmed_demand_level?: DemandLevel | null;
}

export interface BuildAdminDemandZonesGeoJsonOptions {
  /** Single palette when all zones share one service area. */
  palette?: Record<DemandLevel, DemandZoneColorEntry>;
  /** Per-SA palettes when the map shows multiple service areas. */
  paletteByServiceArea?: Map<string, Record<DemandLevel, DemandZoneColorEntry>>;
}

function normalizeLevel(raw: string): DemandLevel {
  const level = raw.trim().toUpperCase();
  if (level === 'HIGH' || level === 'LOW') return level;
  return 'MEDIUM';
}

function resolveDisplayLevel(zone: AdminDemandZone): DemandLevel {
  if (zone.confirmed_demand_level) return normalizeLevel(zone.confirmed_demand_level);
  return normalizeLevel(zone.demand_level);
}

function resolvePalette(
  zone: AdminDemandZone,
  options?: BuildAdminDemandZonesGeoJsonOptions,
): Record<DemandLevel, DemandZoneColorEntry> {
  if (zone.service_area_id && options?.paletteByServiceArea?.has(zone.service_area_id)) {
    return options.paletteByServiceArea.get(zone.service_area_id)!;
  }
  return options?.palette ?? DEMAND_ZONE_COLORS;
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

export function buildPaletteByServiceArea(
  rows: Array<
    Pick<DemandZoneSettings, 'service_area_id' | 'colour_low' | 'colour_medium' | 'colour_high'>
  >,
): Map<string, Record<DemandLevel, DemandZoneColorEntry>> {
  const map = new Map<string, Record<DemandLevel, DemandZoneColorEntry>>();
  for (const row of rows) {
    map.set(row.service_area_id, buildDemandZoneColorPalette(row));
  }
  return map;
}

export function buildAdminDemandZonesGeoJson(
  zones: AdminDemandZone[],
  options?: BuildAdminDemandZonesGeoJsonOptions,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = zones.map((zone) => {
    const level = resolveDisplayLevel(zone);
    const palette = resolvePalette(zone, options);
    const colors = palette[level];
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
