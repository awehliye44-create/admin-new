/**
 * Stacked ride proximity + direction matching (pure, testable).
 * SSOT radius: global_dispatch_settings.stacked_search_radius_meters
 */

export type StackedProximityGateInput = {
  distanceFromDriverMeters: number;
  distanceFromDropoffMeters: number;
  searchRadiusMeters: number;
};

export type StackedProximityGatePass = {
  pass: true;
  matchedBy: "driver" | "dropoff" | "both";
  effectiveDistanceMeters: number;
};

export type StackedProximityGateFail = {
  pass: false;
  reason: "stacked_outside_search_radius";
  distance_from_driver_meters: number;
  distance_from_dropoff_meters: number;
  search_radius_meters: number;
};

/** Gate 8 â new pickup within admin radius of driver OR current dropoff. */
export function evaluateStackedProximityRadiusGate(
  input: StackedProximityGateInput,
): StackedProximityGatePass | StackedProximityGateFail {
  const driverOk = input.distanceFromDriverMeters <= input.searchRadiusMeters;
  const dropoffOk = input.distanceFromDropoffMeters <= input.searchRadiusMeters;

  if (!driverOk && !dropoffOk) {
    return {
      pass: false,
      reason: "stacked_outside_search_radius",
      distance_from_driver_meters: Math.round(input.distanceFromDriverMeters),
      distance_from_dropoff_meters: Math.round(input.distanceFromDropoffMeters),
      search_radius_meters: input.searchRadiusMeters,
    };
  }

  const matchedBy: StackedProximityGatePass["matchedBy"] = driverOk && dropoffOk
    ? "both"
    : driverOk
      ? "driver"
      : "dropoff";

  return {
    pass: true,
    matchedBy,
    effectiveDistanceMeters: Math.round(
      Math.min(input.distanceFromDriverMeters, input.distanceFromDropoffMeters),
    ),
  };
}

export type StackedDirectionInput = {
  activePickupLat: number;
  activePickupLng: number;
  activeDropoffLat: number;
  activeDropoffLng: number;
  newPickupLat: number;
  newPickupLng: number;
  newDropoffLat: number;
  newDropoffLng: number;
};

/** Cosine similarity of active-trip bearing vs new-trip bearing (-1..1). */
export function computeStackedTripDirectionAlignment(input: StackedDirectionInput): number {
  const v1Lat = input.activeDropoffLat - input.activePickupLat;
  const v1Lng = input.activeDropoffLng - input.activePickupLng;
  const v2Lat = input.newDropoffLat - input.newPickupLat;
  const v2Lng = input.newDropoffLng - input.newPickupLng;
  const mag1 = Math.sqrt(v1Lat * v1Lat + v1Lng * v1Lng);
  const mag2 = Math.sqrt(v2Lat * v2Lat + v2Lng * v2Lng);
  if (mag1 <= 0 || mag2 <= 0) return 0;
  return (v1Lat * v2Lat + v1Lng * v2Lng) / (mag1 * mag2);
}

export type StackedSameDirectionGateInput = {
  enforceSameDirection: boolean;
  alignment: number;
  minAlignment?: number;
  /** When new pickup is within dropoff radius, radius SSOT wins over bearing. */
  distanceFromDropoffMeters: number;
  searchRadiusMeters: number;
};

export function evaluateStackedSameDirectionGate(
  _input: StackedSameDirectionGateInput,
): { pass: true; bypassedByRadius?: boolean } {
  /** @deprecated Direction matching removed â stacked eligibility is radius-only. */
  return { pass: true };
}
