import { mapboxgl } from '@/lib/mapbox';
import { buildDemandZoneCircleRing } from '@/lib/demandZoneGeojson';
import type { AdminDemandZone } from '@/lib/demandZoneGeojson';

export const DEFAULT_MAP_CENTER: [number, number] = [-0.7594, 52.0406];
export const DEFAULT_MAP_ZOOM = 11;

/** Rough UK mainland + NI envelope — rejects swapped/invalid coordinates before fitBounds. */
export function isValidUkCoord(lng: number, lat: number): boolean {
  return Number.isFinite(lng)
    && Number.isFinite(lat)
    && lat >= 49
    && lat <= 61
    && lng >= -9
    && lng <= 3;
}

export function fitMapToLngLatBounds(
  map: mapboxgl.Map,
  bounds: mapboxgl.LngLatBounds,
  options?: { padding?: number; maxZoom?: number; duration?: number },
): boolean {
  if (bounds.isEmpty()) return false;
  map.fitBounds(bounds, {
    padding: options?.padding ?? 48,
    maxZoom: options?.maxZoom ?? 14,
    duration: options?.duration ?? 600,
  });
  return true;
}

export function extendBoundsForDemandZone(
  bounds: mapboxgl.LngLatBounds,
  zone: Pick<AdminDemandZone, 'center_lat' | 'center_lng' | 'radius_meters'>,
): void {
  if (!isValidUkCoord(zone.center_lng, zone.center_lat)) return;
  const ring = buildDemandZoneCircleRing(zone.center_lat, zone.center_lng, zone.radius_meters, 12);
  for (const [lng, lat] of ring) {
    if (isValidUkCoord(lng, lat)) bounds.extend([lng, lat]);
  }
}

export function extendBoundsForPolygon(
  bounds: mapboxgl.LngLatBounds,
  polygon?: GeoJSON.Polygon | null,
): void {
  if (!polygon?.coordinates?.[0]) return;
  for (const coord of polygon.coordinates[0]) {
    const lng = coord[0];
    const lat = coord[1];
    if (isValidUkCoord(lng, lat)) bounds.extend([lng, lat]);
  }
}

export function buildDemandZonesBounds(
  zones: AdminDemandZone[],
  boundary?: GeoJSON.Polygon | null,
): mapboxgl.LngLatBounds | null {
  const bounds = new mapboxgl.LngLatBounds();

  for (const zone of zones) {
    extendBoundsForDemandZone(bounds, zone);
  }
  if (boundary) {
    extendBoundsForPolygon(bounds, boundary);
  }

  return bounds.isEmpty() ? null : bounds;
}

export type DriverMapPosition = { lat: number; lng: number };

export function collectDriverMapPositions(
  drivers: Array<{
    current_lat: number | null;
    current_lng: number | null;
    region_id?: string;
  }>,
  regions: Array<{ id: string; geo_boundary?: unknown }>,
): DriverMapPosition[] {
  const positions: DriverMapPosition[] = [];

  for (const driver of drivers) {
    if (driver.current_lat != null && driver.current_lng != null) {
      if (isValidUkCoord(driver.current_lng, driver.current_lat)) {
        positions.push({ lat: driver.current_lat, lng: driver.current_lng });
      }
      continue;
    }

    const region = regions.find((r) => r.id === driver.region_id);
    const boundary = region?.geo_boundary as Array<{ lat: number; lng: number }> | undefined;
    if (boundary?.[0]?.lat != null && boundary?.[0]?.lng != null) {
      const { lat, lng } = boundary[0];
      if (isValidUkCoord(lng, lat)) {
        positions.push({ lat, lng });
      }
    }
  }

  return positions;
}

export function boundsFromPositions(positions: DriverMapPosition[]): mapboxgl.LngLatBounds | null {
  if (positions.length === 0) return null;
  const bounds = new mapboxgl.LngLatBounds();
  for (const position of positions) {
    bounds.extend([position.lng, position.lat]);
  }
  return bounds;
}

export function recenterMap(
  map: mapboxgl.Map,
  center: [number, number] = DEFAULT_MAP_CENTER,
  zoom = DEFAULT_MAP_ZOOM,
): void {
  map.flyTo({ center, zoom, duration: 600 });
}
