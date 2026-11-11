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

function coerceFiniteNumber(raw: unknown): number | null {
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

/** Read fleet max miles from a global_dispatch_settings-shaped row (or null). */
export function fleetMaxPickupMilesFromDispatchRow(
  row: Record<string, unknown> | null | undefined,
): number {
  return resolveFleetMaxPickupDistanceMiles(row?.fleet_max_pickup_distance_miles);
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

/** Admin save validation — blank / non-finite blocked; range 1–100 miles. */
export function validateFleetMaxPickupDistanceMiles(
  raw: unknown,
): FleetMaxPickupDistanceIssue[] {
  const n = coerceFiniteNumber(raw);
  if (n == null) {
    return [{ code: "required", message: "Fleet maximum pickup distance is required" }];
  }
  if (n < FLEET_MAX_PICKUP_DISTANCE_MILES_MIN || n > FLEET_MAX_PICKUP_DISTANCE_MILES_MAX) {
    return [{
      code: "out_of_range",
      message:
        `Fleet maximum pickup distance must be between ${FLEET_MAX_PICKUP_DISTANCE_MILES_MIN} and ${FLEET_MAX_PICKUP_DISTANCE_MILES_MAX} miles`,
    }];
  }
  return [];
}
