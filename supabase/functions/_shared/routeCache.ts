/**
 * Route & ETA caching layer — backend-only.
 * Enforces TTL-based caching and trigger-based rerouting per the Low-Cost Architecture rules.
 *
 * TTL defaults:
 *   - pre-pickup (driver_to_pickup): 90 seconds
 *   - active trip (pickup_to_dropoff): 45 seconds
 */

import { getDirections, type DirectionsResult } from "./mapbox.ts";

export type RouteLeg = "driver_to_pickup" | "pickup_to_dropoff";

export type RerouteReason =
  | "trip_assigned"
  | "trip_started"
  | "destination_changed"
  | "off_route"
  | "eta_drift"
  | "manual";

interface CachedRoute {
  distance_km: number;
  duration_min: number;
  polyline: string | null;
  eta_at: string;
  cached_at: string;
  expires_at: string;
  reroute_reason: string;
}

const TTL_SECONDS: Record<RouteLeg, number> = {
  driver_to_pickup: 90,
  pickup_to_dropoff: 45,
};

/**
 * Get a route, using the cache when valid. Calls Google only on cache miss/expiry.
 */
export async function getRouteWithCache(
  supabase: any,
  tripId: string,
  leg: RouteLeg,
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number,
  reason: RerouteReason = "trip_assigned",
  forceRefresh = false,
  waypoints?: { lat: number; lng: number }[]
): Promise<CachedRoute> {
  if (!forceRefresh) {
    const cached = await getCachedRoute(supabase, tripId, leg);
    if (cached) {
      console.log(`[routeCache] HIT ${leg} for trip ${tripId} (expires ${cached.expires_at})`);
      return cached;
    }
  }

  console.log(`[routeCache] MISS ${leg} for trip ${tripId} — calling Google (reason: ${reason})`);

  const directions = await getDirections(originLat, originLng, destLat, destLng, waypoints);

  const now = new Date();
  const ttl = TTL_SECONDS[leg];
  const expiresAt = new Date(now.getTime() + ttl * 1000);
  const etaAt = new Date(now.getTime() + directions.duration_min * 60 * 1000);

  const cacheEntry: CachedRoute = {
    distance_km: directions.distance_km,
    duration_min: directions.duration_min,
    polyline: directions.polyline,
    eta_at: etaAt.toISOString(),
    cached_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    reroute_reason: reason,
  };

  await upsertCache(supabase, tripId, leg, originLat, originLng, destLat, destLng, cacheEntry);

  return cacheEntry;
}

/**
 * Check if a reroute is warranted based on triggers (not time-based polling).
 * Returns the reason if reroute needed, null otherwise.
 */
export function checkRerouteTrigger(
  driverLat: number,
  driverLng: number,
  cachedOriginLat: number,
  cachedOriginLng: number,
  cachedEtaAt: string,
  currentDurationEstimateMin: number,
  offRouteThresholdMeters = 150,
  etaDriftThresholdMin = 3
): RerouteReason | null {
  // 1. Off-route check: driver is > threshold from cached route origin
  const offRouteDistance = haversineMeters(driverLat, driverLng, cachedOriginLat, cachedOriginLng);
  if (offRouteDistance > offRouteThresholdMeters) {
    return "off_route";
  }

  // 2. ETA drift check: actual ETA differs significantly from cached ETA
  const cachedEtaMs = new Date(cachedEtaAt).getTime();
  const currentEstimatedEtaMs = Date.now() + currentDurationEstimateMin * 60 * 1000;
  const driftMinutes = Math.abs(cachedEtaMs - currentEstimatedEtaMs) / 60000;
  if (driftMinutes > etaDriftThresholdMin) {
    return "eta_drift";
  }

  return null;
}

/**
 * Invalidate cache for a trip (e.g., destination changed).
 */
export async function invalidateRouteCache(
  supabase: any,
  tripId: string,
  leg?: RouteLeg
): Promise<void> {
  let query = supabase.from("trip_route_cache").delete().eq("trip_id", tripId);
  if (leg) query = query.eq("leg", leg);
  await query;
  console.log(`[routeCache] Invalidated ${leg || "all legs"} for trip ${tripId}`);
}

// ---- Internal helpers ----

async function getCachedRoute(
  supabase: any,
  tripId: string,
  leg: RouteLeg
): Promise<CachedRoute | null> {
  const { data } = await supabase
    .from("trip_route_cache")
    .select("distance_km, duration_min, polyline, eta_at, cached_at, expires_at, reroute_reason")
    .eq("trip_id", tripId)
    .eq("leg", leg)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  return data || null;
}

async function upsertCache(
  supabase: any,
  tripId: string,
  leg: RouteLeg,
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number,
  entry: CachedRoute
): Promise<void> {
  const { error } = await supabase.from("trip_route_cache").upsert(
    {
      trip_id: tripId,
      leg,
      origin_lat: originLat,
      origin_lng: originLng,
      dest_lat: destLat,
      dest_lng: destLng,
      distance_km: entry.distance_km,
      duration_min: entry.duration_min,
      polyline: entry.polyline,
      eta_at: entry.eta_at,
      cached_at: entry.cached_at,
      expires_at: entry.expires_at,
      reroute_reason: entry.reroute_reason,
    },
    { onConflict: "trip_id,leg" }
  );

  if (error) {
    console.error(`[routeCache] Upsert error for ${leg}:`, error);
  }
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
