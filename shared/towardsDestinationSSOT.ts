/**
 * Towards Destination SSOT — pure helpers (matching + usage window).
 * Production SQL RPCs remain authoritative; these helpers mirror the contract
 * for Edge (auto-dispatch) and unit tests.
 */

export const TOWARDS_DESTINATION_WINDOW_TYPE = "rolling_24_hours" as const;

export type TowardsDestinationUsageSnapshot = {
  limit: number;
  completed_last_24h: number;
  remaining: number;
  window_type: typeof TOWARDS_DESTINATION_WINDOW_TYPE;
  next_available_at: string | null;
};

export type TowardsDestinationMatchConfig = {
  /** Slack on progress comparison (metres). dropoff_to_dest < driver_to_dest + tolerance */
  matchingToleranceMeters: number;
  /** Require at least this many metres of progress toward dest (default 100). */
  minProgressMeters: number;
  /** Reject if driver→pickup exceeds this (0 = disabled). */
  maxPickupDetourMeters: number;
};

export type TowardsDestinationMatchInput = {
  driverLat: number;
  driverLng: number;
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  destLat: number;
  destLng: number;
};

export type TowardsDestinationMatchResult = {
  qualifies: boolean;
  reason:
    | "ok"
    | "invalid_coords"
    | "no_progress"
    | "pickup_detour_exceeded";
  driverToDestMeters: number | null;
  dropoffToDestMeters: number | null;
  driverToPickupMeters: number | null;
  progressMeters: number | null;
};

const EARTH_RADIUS_M = 6_371_000;

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function coordsValid(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

/**
 * Directional dispatch filter — coordinates only (no postcode string match).
 * Qualifies when drop-off is meaningfully closer to dest than the driver is,
 * with configurable tolerance / min progress / max pickup detour.
 */
export function towardsDestinationTripQualifies(
  input: TowardsDestinationMatchInput,
  config: TowardsDestinationMatchConfig,
): TowardsDestinationMatchResult {
  const {
    driverLat,
    driverLng,
    pickupLat,
    pickupLng,
    dropoffLat,
    dropoffLng,
    destLat,
    destLng,
  } = input;

  if (
    !coordsValid(driverLat, driverLng) ||
    !coordsValid(pickupLat, pickupLng) ||
    !coordsValid(dropoffLat, dropoffLng) ||
    !coordsValid(destLat, destLng)
  ) {
    return {
      qualifies: false,
      reason: "invalid_coords",
      driverToDestMeters: null,
      dropoffToDestMeters: null,
      driverToPickupMeters: null,
      progressMeters: null,
    };
  }

  const driverToDest = haversineMeters(driverLat, driverLng, destLat, destLng);
  const dropoffToDest = haversineMeters(dropoffLat, dropoffLng, destLat, destLng);
  const driverToPickup = haversineMeters(driverLat, driverLng, pickupLat, pickupLng);
  const progress = driverToDest - dropoffToDest;
  const tolerance = Math.max(config.matchingToleranceMeters ?? 0, 0);
  const minProgress = Math.max(config.minProgressMeters ?? 0, 0);
  const maxDetour = Math.max(config.maxPickupDetourMeters ?? 0, 0);

  // dropoff closer (with tolerance) AND meaningful progress
  if (!(dropoffToDest < driverToDest + tolerance && progress >= minProgress)) {
    return {
      qualifies: false,
      reason: "no_progress",
      driverToDestMeters: driverToDest,
      dropoffToDestMeters: dropoffToDest,
      driverToPickupMeters: driverToPickup,
      progressMeters: progress,
    };
  }

  if (maxDetour > 0 && driverToPickup > maxDetour) {
    return {
      qualifies: false,
      reason: "pickup_detour_exceeded",
      driverToDestMeters: driverToDest,
      dropoffToDestMeters: dropoffToDest,
      driverToPickupMeters: driverToPickup,
      progressMeters: progress,
    };
  }

  return {
    qualifies: true,
    reason: "ok",
    driverToDestMeters: driverToDest,
    dropoffToDestMeters: dropoffToDest,
    driverToPickupMeters: driverToPickup,
    progressMeters: progress,
  };
}

export function isInsideArrivalRadius(args: {
  lat: number;
  lng: number;
  destLat: number;
  destLng: number;
  arrivalRadiusMeters: number;
}): boolean {
  if (
    !coordsValid(args.lat, args.lng) ||
    !coordsValid(args.destLat, args.destLng)
  ) {
    return false;
  }
  const radius = Math.max(args.arrivalRadiusMeters ?? 0, 0);
  return (
    haversineMeters(args.lat, args.lng, args.destLat, args.destLng) <= radius
  );
}

/**
 * Authoritative usage snapshot shape returned by RPCs.
 * Counts only successful completions in the rolling 24h window.
 */
export function buildTowardsDestinationUsageSnapshot(args: {
  limit: number;
  completedLast24h: number;
  completedAtTimestamps?: string[];
  now?: Date;
}): TowardsDestinationUsageSnapshot {
  const limit = Math.max(Math.floor(args.limit), 0);
  const completed = Math.max(Math.floor(args.completedLast24h), 0);
  const remaining = Math.max(limit - completed, 0);
  let nextAvailableAt: string | null = null;

  if (remaining === 0 && args.completedAtTimestamps?.length) {
    const now = args.now ?? new Date();
    const windowMs = 24 * 60 * 60 * 1000;
    const sorted = [...args.completedAtTimestamps]
      .map((t) => new Date(t).getTime())
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);
    // Oldest completion inside the window frees a slot first.
    const inWindow = sorted.filter((t) => now.getTime() - t < windowMs);
    if (inWindow.length >= limit && inWindow[0] != null) {
      nextAvailableAt = new Date(inWindow[0] + windowMs).toISOString();
    }
  }

  return {
    limit,
    completed_last_24h: completed,
    remaining,
    window_type: TOWARDS_DESTINATION_WINDOW_TYPE,
    next_available_at: nextAvailableAt,
  };
}
