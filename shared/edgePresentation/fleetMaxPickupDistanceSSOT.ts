/** Admin presentation-only helpers; not part of Edge uploads. */
import { FleetMaxPickupDistanceIssue, coerceFiniteNumber, FLEET_MAX_PICKUP_DISTANCE_MILES_MIN, FLEET_MAX_PICKUP_DISTANCE_MILES_MAX } from "../../supabase/functions/_shared/fleetMaxPickupDistanceSSOT.ts";


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

export * from "../../supabase/functions/_shared/fleetMaxPickupDistanceSSOT.ts";
