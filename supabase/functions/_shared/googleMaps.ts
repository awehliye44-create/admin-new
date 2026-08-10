/**
 * Shared Google Maps Platform helpers for Edge Functions.
 *
 * Backend is the SOT for ALL routing / ETA / distance work.
 * Uses the server key stored as GOOGLE_API_KEY (falls back to GOOGLE_MAPS_API_KEY).
 * Frontend must NEVER call these APIs directly — it only renders maps.
 */

export interface DirectionsResult {
  distance_km: number;
  duration_min: number;
  polyline: string | null;
}

export interface DistanceMatrixEntry {
  origin_index: number;
  destination_index: number;
  distance_km: number;
  duration_min: number;
}

const ROUTES_BASE = "https://routes.googleapis.com";

function getApiKey(): string {
  const key = Deno.env.get("GOOGLE_API_KEY") || Deno.env.get("GOOGLE_MAPS_API_KEY");
  if (!key) {
    throw new Error("GOOGLE_API_KEY is not configured for backend routing");
  }
  return key;
}

function waypoint(lat: number, lng: number) {
  return { location: { latLng: { latitude: lat, longitude: lng } } };
}

function parseDurationSeconds(duration: unknown): number {
  if (typeof duration === "number") return duration;
  if (typeof duration === "string") return parseFloat(duration.replace("s", "")) || 0;
  return 0;
}

async function googleFetch(path: string, fieldMask: string, body: unknown): Promise<any> {
  const res = await fetch(`${ROUTES_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": getApiKey(),
      "X-Goog-FieldMask": fieldMask,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[googleMaps] ${path} HTTP ${res.status}: ${text}`);
    throw new Error(`Google Routes ${path} HTTP ${res.status}: ${text}`);
  }

  return await res.json();
}

/**
 * Driving directions between two points (with optional via-waypoints).
 * Returns distance in km, duration in minutes, and an encoded polyline (precision 5).
 */
export async function getDirections(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number,
  waypoints?: { lat: number; lng: number }[],
): Promise<DirectionsResult> {
  const data = await googleFetch(
    "/directions/v2:computeRoutes",
    "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
    {
      origin: waypoint(originLat, originLng),
      destination: waypoint(destLat, destLng),
      intermediates: (waypoints || []).map((w) => waypoint(w.lat, w.lng)),
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
      polylineEncoding: "ENCODED_POLYLINE",
    },
  );

  const route = data?.routes?.[0];
  if (!route) {
    throw new Error("Google Routes returned no route");
  }

  return {
    distance_km: Math.round(((route.distanceMeters ?? 0) / 1000) * 10) / 10,
    duration_min: Math.round(parseDurationSeconds(route.duration) / 60),
    polyline: route.polyline?.encodedPolyline ?? null,
  };
}

/**
 * Distance matrix between origins and destinations.
 * Google allows up to 625 origin x destination pairs per request; we batch conservatively.
 */
export async function getDistanceMatrix(
  origins: { lat: number; lng: number }[],
  destinations: { lat: number; lng: number }[],
): Promise<DistanceMatrixEntry[]> {
  if (origins.length === 0 || destinations.length === 0) return [];

  const MAX_PAIRS = 500;
  const maxOriginsPerBatch = Math.max(1, Math.floor(MAX_PAIRS / destinations.length));
  const results: DistanceMatrixEntry[] = [];

  for (let i = 0; i < origins.length; i += maxOriginsPerBatch) {
    const batchOrigins = origins.slice(i, i + maxOriginsPerBatch);

    let rows: any[];
    try {
      rows = await googleFetch(
        "/distanceMatrix/v2:computeRouteMatrix",
        "originIndex,destinationIndex,distanceMeters,duration,condition",
        {
          origins: batchOrigins.map((o) => ({ waypoint: waypoint(o.lat, o.lng) })),
          destinations: destinations.map((d) => ({ waypoint: waypoint(d.lat, d.lng) })),
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_AWARE",
        },
      );
    } catch (err) {
      console.error("[googleMaps] Matrix batch failed:", err);
      continue;
    }

    for (const row of Array.isArray(rows) ? rows : []) {
      if (row?.condition && row.condition !== "ROUTE_EXISTS") continue;
      if (row?.distanceMeters == null || row?.duration == null) continue;
      results.push({
        origin_index: i + (row.originIndex ?? 0),
        destination_index: row.destinationIndex ?? 0,
        distance_km: Math.round((row.distanceMeters / 1000) * 10) / 10,
        duration_min: Math.round(parseDurationSeconds(row.duration) / 60),
      });
    }
  }

  return results;
}
