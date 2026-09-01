/**
 * Driver demand zone compute — buckets open trips and applies per-SA SSOT settings
 * (thresholds, lifetime, radius, hysteresis).
 */

import {
  applyHysteresis,
  proposeLevel,
  type DemandLevel,
  type DemandZoneSettings,
  OPEN_TRIP_DEMAND_STATUSES,
} from "../../../shared/demandZoneSurgeSSOT.ts";

/** ~500 m grid step at UK latitudes. */
export const DEMAND_GRID_STEP = 0.0045;

export interface TripForDemand {
  id: string;
  service_area_id: string;
  pickup_latitude: number;
  pickup_longitude: number;
  status: string;
  driver_id: string | null;
  confirmed_driver_id: string | null;
  created_at: string;
}

export interface OpenTripPickup {
  service_area_id: string | null;
  pickup_latitude: number;
  pickup_longitude: number;
}

export interface DemandGridCell {
  service_area_id: string;
  center_lat: number;
  center_lng: number;
  open_trip_count: number;
}

export interface ExistingComputedZone {
  id: string;
  center_lat: number;
  center_lng: number;
  proposed_demand_level: DemandLevel | null;
  confirmed_demand_level: DemandLevel | null;
  consecutive_match_count: number;
  level_changed_at?: string | null;
}

export interface ComputedZoneUpsert {
  id?: string;
  name: string;
  center_lat: number;
  center_lng: number;
  radius_meters: number;
  demand_level: DemandLevel;
  proposed_demand_level: DemandLevel;
  confirmed_demand_level: DemandLevel;
  consecutive_match_count: number;
  last_open_trip_count: number;
  last_evaluated_at: string;
  level_changed_at: string | null;
  active: boolean;
  region_id: string | null;
  service_area_id: string;
  source: "computed";
}

export function snapToDemandGrid(lat: number, lng: number): { lat: number; lng: number } {
  return {
    lat: Math.round(lat / DEMAND_GRID_STEP) * DEMAND_GRID_STEP,
    lng: Math.round(lng / DEMAND_GRID_STEP) * DEMAND_GRID_STEP,
  };
}

export function gridCellKey(
  serviceAreaId: string,
  lat: number,
  lng: number,
): string {
  return `${serviceAreaId}:${lat.toFixed(4)}:${lng.toFixed(4)}`;
}

export function bucketOpenTripsIntoGrid(
  trips: OpenTripPickup[],
  serviceAreaId: string,
): DemandGridCell[] {
  const counts = new Map<string, DemandGridCell>();

  for (const trip of trips) {
    const lat = Number(trip.pickup_latitude);
    const lng = Number(trip.pickup_longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const snapped = snapToDemandGrid(lat, lng);
    const key = gridCellKey(serviceAreaId, snapped.lat, snapped.lng);
    const existing = counts.get(key);
    if (existing) {
      existing.open_trip_count += 1;
      continue;
    }
    counts.set(key, {
      service_area_id: serviceAreaId,
      center_lat: snapped.lat,
      center_lng: snapped.lng,
      open_trip_count: 1,
    });
  }

  return [...counts.values()];
}

export function filterOpenTripsForDemand(
  trips: TripForDemand[],
  serviceAreaId: string,
  nowMs: number,
  openTripMaxLifetimeMinutes: number,
): TripForDemand[] {
  const lifetimeMs = openTripMaxLifetimeMinutes * 60_000;
  const statuses = OPEN_TRIP_DEMAND_STATUSES as readonly string[];

  return trips.filter((trip) => {
    if (trip.service_area_id !== serviceAreaId) return false;
    if (trip.driver_id || trip.confirmed_driver_id) return false;
    if (!statuses.includes(String(trip.status).toLowerCase())) return false;
    const created = new Date(trip.created_at).getTime();
    if (!Number.isFinite(created) || nowMs - created > lifetimeMs) return false;
    const lat = Number(trip.pickup_latitude);
    const lng = Number(trip.pickup_longitude);
    return Number.isFinite(lat) && Number.isFinite(lng);
  });
}

function existingZonesByGridKey(
  zones: ExistingComputedZone[],
  serviceAreaId: string,
): Map<string, ExistingComputedZone> {
  const map = new Map<string, ExistingComputedZone>();
  for (const zone of zones) {
    const snapped = snapToDemandGrid(zone.center_lat, zone.center_lng);
    map.set(gridCellKey(serviceAreaId, snapped.lat, snapped.lng), zone);
  }
  return map;
}

type SettingsSlice = Pick<
  DemandZoneSettings,
  | "low_min_trips"
  | "low_max_trips"
  | "medium_min_trips"
  | "medium_max_trips"
  | "high_min_trips"
  | "consecutive_checks_required"
  | "zone_radius_meters"
  | "open_trip_max_lifetime_minutes"
>;

/** Derive computed zone rows for one service area using saved heat-map settings. */
export function evaluateComputedZonesForServiceArea(params: {
  trips: TripForDemand[];
  settings: SettingsSlice;
  existingZones: ExistingComputedZone[];
  regionId: string | null;
  serviceAreaId: string;
  evaluatedAtIso: string;
}): ComputedZoneUpsert[] {
  const {
    trips,
    settings,
    existingZones,
    regionId,
    serviceAreaId,
    evaluatedAtIso,
  } = params;

  const nowMs = new Date(evaluatedAtIso).getTime();
  const eligible = filterOpenTripsForDemand(
    trips,
    serviceAreaId,
    nowMs,
    settings.open_trip_max_lifetime_minutes,
  );
  const cells = bucketOpenTripsIntoGrid(
    eligible.map((t) => ({
      service_area_id: serviceAreaId,
      pickup_latitude: t.pickup_latitude,
      pickup_longitude: t.pickup_longitude,
    })),
    serviceAreaId,
  );
  const existingByKey = existingZonesByGridKey(existingZones, serviceAreaId);
  const rows: ComputedZoneUpsert[] = [];

  for (const cell of cells) {
    if (cell.open_trip_count < settings.low_min_trips) continue;

    const proposed = proposeLevel(cell.open_trip_count, settings);
    const key = gridCellKey(serviceAreaId, cell.center_lat, cell.center_lng);
    const prior = existingByKey.get(key);
    const priorConfirmed = (prior?.confirmed_demand_level ?? prior?.proposed_demand_level ?? "LOW") as DemandLevel;

    const hysteresis = applyHysteresis(
      {
        proposed_demand_level: prior?.proposed_demand_level ?? null,
        confirmed_demand_level: priorConfirmed,
        consecutive_match_count: prior?.consecutive_match_count ?? 0,
      },
      proposed,
      settings.consecutive_checks_required,
    );

    rows.push({
      id: prior?.id,
      name: `[AUTO] ${cell.open_trip_count} open • ${cell.center_lat.toFixed(3)}, ${cell.center_lng.toFixed(3)} • ${hysteresis.confirmed_demand_level}`,
      center_lat: cell.center_lat,
      center_lng: cell.center_lng,
      radius_meters: settings.zone_radius_meters,
      demand_level: hysteresis.confirmed_demand_level,
      proposed_demand_level: hysteresis.proposed_demand_level ?? proposed,
      confirmed_demand_level: hysteresis.confirmed_demand_level,
      consecutive_match_count: hysteresis.consecutive_match_count,
      last_open_trip_count: cell.open_trip_count,
      last_evaluated_at: evaluatedAtIso,
      level_changed_at: hysteresis.changed
        ? evaluatedAtIso
        : (prior?.level_changed_at ?? null),
      active: true,
      region_id: regionId,
      service_area_id: serviceAreaId,
      source: "computed",
    });
  }

  return rows;
}
