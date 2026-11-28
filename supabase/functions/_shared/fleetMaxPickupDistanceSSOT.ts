/**
 * Fleet maximum pickup distance SSOT.
 *
 * Authoritative config: global_dispatch_settings.fleet_max_pickup_distance_miles
 * Failsafe: 17.8 miles whenever the value is missing, null, NaN, ≤ 0, or unreadable.
 *
 * Independent of MK booking wave radii (start/expand/max_radius_meters). Wave radii
 * still gate progressive broadcast; this fleet cap applies to every offer path for
 * every eligible driver (including drivers with no driver_settings row).
 */

export const FLEET_MAX_PICKUP_DISTANCE_MILES_FAILSAFE = 17.8;

/** Statute mile → metres (international). */
export const FLEET_MAX_PICKUP_MILES_TO_METERS = 1609.34;

export const FLEET_MAX_PICKUP_DISTANCE_MILES_MIN = 1;
export const FLEET_MAX_PICKUP_DISTANCE_MILES_MAX = 100;

/** Canonical eligibility / audit reject reason (distinct from wave outside_radius). */
export const EXCEEDS_FLEET_MAX_PICKUP_DISTANCE = "exceeds_fleet_max_pickup_distance" as const;

export type FleetMaxPickupDistanceIssue = {
  code: "required" | "out_of_range";
  message: string;
};

export function coerceFiniteNumber(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return null;
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Resolve Admin / DB miles to a positive finite value.
 * Invalid or missing → failsafe 17.8 (never disable the distance gate).
 */
export function resolveFleetMaxPickupDistanceMiles(raw: unknown): number {
  const n = coerceFiniteNumber(raw);
  if (n == null || n <= 0) return FLEET_MAX_PICKUP_DISTANCE_MILES_FAILSAFE;
  return n;
}

export function fleetMaxPickupDistanceMeters(rawMiles: unknown): number {
  return resolveFleetMaxPickupDistanceMiles(rawMiles) * FLEET_MAX_PICKUP_MILES_TO_METERS;
}

export function fleetMaxPickupMetersFromDispatchRow(
  row: Record<string, unknown> | null | undefined,
): number {
  return fleetMaxPickupDistanceMeters(row?.fleet_max_pickup_distance_miles);
}

export function exceedsFleetMaxPickupDistance(
  distanceMeters: number,
  fleetMaxMilesRaw: unknown,
): boolean {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) return true;
  return distanceMeters > fleetMaxPickupDistanceMeters(fleetMaxMilesRaw);
}
