/**
 * Bucket open trip pickups into driver demand zones (visual guidance only).
 */

export const OPEN_TRIP_STATUSES = [
  "searching",
  "searching_new_driver",
  "offered",
  "broadcasting",
  "negotiating",
  "offering",
] as const;

/** ~500 m grid step at UK latitudes. */
export const DEMAND_GRID_STEP = 0.0045;

export const DEMAND_LOOKBACK_MINUTES = 45;

export interface OpenTripPickup {
  service_area_id: string | null;
  pickup_latitude: number;
  pickup_longitude: number;
}

export interface DemandGridCell {
  service_area_id: string | null;
  center_lat: number;
  center_lng: number;
  open_trip_count: number;
}

export function snapToDemandGrid(lat: number, lng: number): { lat: number; lng: number } {
  return {
    lat: Math.round(lat / DEMAND_GRID_STEP) * DEMAND_GRID_STEP,
    lng: Math.round(lng / DEMAND_GRID_STEP) * DEMAND_GRID_STEP,
  };
}

export function gridCellKey(
  serviceAreaId: string | null,
  lat: number,
  lng: number,
): string {
  return `${serviceAreaId ?? "global"}:${lat.toFixed(4)}:${lng.toFixed(4)}`;
}

export function bucketOpenTripsIntoGrid(trips: OpenTripPickup[]): DemandGridCell[] {
  const counts = new Map<string, DemandGridCell>();

  for (const trip of trips) {
    const lat = Number(trip.pickup_latitude);
    const lng = Number(trip.pickup_longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const snapped = snapToDemandGrid(lat, lng);
    const key = gridCellKey(trip.service_area_id, snapped.lat, snapped.lng);
    const existing = counts.get(key);
    if (existing) {
      existing.open_trip_count += 1;
      continue;
    }
    counts.set(key, {
      service_area_id: trip.service_area_id,
      center_lat: snapped.lat,
      center_lng: snapped.lng,
      open_trip_count: 1,
    });
  }

  return [...counts.values()];
}

export function demandLevelFromOpenCount(count: number): "LOW" | "MEDIUM" | "HIGH" | null {
  if (count >= 4) return "HIGH";
  if (count >= 2) return "MEDIUM";
  if (count >= 1) return "LOW";
  return null;
}

export function radiusMetersFromOpenCount(count: number): number {
  if (count >= 4) return 900;
  if (count >= 2) return 700;
  return 550;
}

export interface ComputedDemandZoneRow {
  name: string;
  center_lat: number;
  center_lng: number;
  radius_meters: number;
  demand_level: "LOW" | "MEDIUM" | "HIGH";
  active: boolean;
  region_id: string | null;
  service_area_id: string | null;
  source: "computed";
}

export function buildComputedDemandZoneRows(
  cells: DemandGridCell[],
  regionByServiceArea: Map<string, string | null>,
): ComputedDemandZoneRow[] {
  const rows: ComputedDemandZoneRow[] = [];

  for (const cell of cells) {
    const level = demandLevelFromOpenCount(cell.open_trip_count);
    if (!level) continue;

    rows.push({
      name: `[AUTO] ${cell.open_trip_count} open • ${cell.center_lat.toFixed(3)}, ${cell.center_lng.toFixed(3)}`,
      center_lat: cell.center_lat,
      center_lng: cell.center_lng,
      radius_meters: radiusMetersFromOpenCount(cell.open_trip_count),
      demand_level: level,
      active: true,
      service_area_id: cell.service_area_id,
      region_id: cell.service_area_id
        ? (regionByServiceArea.get(cell.service_area_id) ?? null)
        : null,
      source: "computed",
    });
  }

  return rows;
}
