/**
 * Phase 4 — directional ranking preference toward a confirmed scheduled pickup.
 *
 * Soft preference only: boosts candidates whose dropoff reduces empty travel to
 * the next confirmed scheduled pickup. Never hard-excludes other-direction
 * journeys when commitment feasibility already passed.
 * Drivers without a scheduled commitment → boost 0 (unchanged ranking).
 */

export type ScheduledPickupAnchor = {
  lat: number;
  lng: number;
  scheduledAtMs: number;
};

export type DirectionalRankInput = {
  /** Candidate trip dropoff (instant/stacked destination). */
  dropoffLat: number;
  dropoffLng: number;
  /** Driver current / completion location. */
  fromLat: number;
  fromLng: number;
  scheduledPickup: ScheduledPickupAnchor | null;
  /** Optional: metres — dropoffs within this of pickup count as "near area". */
  nearPickupRadiusMeters?: number;
};

export type DirectionalRankResult = {
  /** Added to dispatch score (higher = preferred). 0 when no commitment. */
  scoreBoost: number;
  emptyTravelSavedMeters: number;
  dropoffToPickupMeters: number;
  fromToPickupMeters: number;
  nearer: boolean;
  nearPickupArea: boolean;
};

function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Preference score: reward ending closer to scheduled pickup than current position.
 * Near-area bonus when dropoff is within radius of pickup.
 */
export function computeScheduledDirectionalScoreBoost(
  input: DirectionalRankInput,
): DirectionalRankResult {
  const empty = {
    scoreBoost: 0,
    emptyTravelSavedMeters: 0,
    dropoffToPickupMeters: 0,
    fromToPickupMeters: 0,
    nearer: false,
    nearPickupArea: false,
  };
  if (!input.scheduledPickup) return empty;
  const { lat, lng } = input.scheduledPickup;
  if (![input.dropoffLat, input.dropoffLng, input.fromLat, input.fromLng, lat, lng].every(
    (n) => Number.isFinite(n),
  )) {
    return empty;
  }

  const fromToPickup = haversineMeters(input.fromLat, input.fromLng, lat, lng);
  const dropoffToPickup = haversineMeters(
    input.dropoffLat,
    input.dropoffLng,
    lat,
    lng,
  );
  const saved = fromToPickup - dropoffToPickup;
  const nearer = saved > 0;
  const nearRadius = Math.max(500, Number(input.nearPickupRadiusMeters) || 3000);
  const nearPickupArea = dropoffToPickup <= nearRadius;

  // Soft boost: up to +25 for large empty-travel savings; +8 near-area.
  // Never negative (other directions stay fully eligible — ranking only).
  let scoreBoost = 0;
  if (nearer) {
    const savedKm = saved / 1000;
    scoreBoost += Math.min(25, savedKm * 4);
  }
  if (nearPickupArea) {
    scoreBoost += 8;
  }

  return {
    scoreBoost,
    emptyTravelSavedMeters: Math.max(0, saved),
    dropoffToPickupMeters: dropoffToPickup,
    fromToPickupMeters: fromToPickup,
    nearer,
    nearPickupArea,
  };
}

/**
 * Sort comparator helper: higher directional boost first when base scores equal.
 * Prefer wrapping into computeDispatchScore rather than replacing it.
 */
export function compareWithDirectionalBoost(input: {
  scoreA: number;
  scoreB: number;
  boostA: number;
  boostB: number;
  distanceA: number;
  distanceB: number;
}): number {
  const totalA = input.scoreA + input.boostA;
  const totalB = input.scoreB + input.boostB;
  if (totalA !== totalB) return totalB - totalA;
  return input.distanceA - input.distanceB;
}
