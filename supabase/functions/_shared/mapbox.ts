/**
 * Shared Mapbox API helpers for Edge Functions.
 * Uses the public Mapbox token (pk.*). Token can be overridden via MAPBOX_PUBLIC_TOKEN secret.
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

const DEFAULT_MAPBOX_TOKEN =
  "pk.eyJ1Ijoib25lY2FiMjAyNSIsImEiOiJjbW9rOGl6emwwNndmMnFzYnZkMGhjd2xkIn0.U2w1e_137y-k_prtNL2AWg";

function getToken(): string {
  return Deno.env.get("MAPBOX_PUBLIC_TOKEN") || DEFAULT_MAPBOX_TOKEN;
}

function coordsParam(points: { lat: number; lng: number }[]): string {
  // Mapbox expects lng,lat;lng,lat
  return points.map((p) => `${p.lng},${p.lat}`).join(";");
}

/**
 * Get driving directions between two points (with optional via-waypoints).
 * Returns distance in km, duration in minutes, and encoded polyline (precision 5).
 */
export async function getDirections(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number,
  waypoints?: { lat: number; lng: number }[],
): Promise<DirectionsResult> {
  const token = getToken();
  const all: { lat: number; lng: number }[] = [
    { lat: originLat, lng: originLng },
    ...(waypoints || []),
    { lat: destLat, lng: destLng },
  ];

  const url =
    `https://api.mapbox.com/directions/v5/mapbox/driving/${coordsParam(all)}` +
    `?geometries=polyline&overview=full&access_token=${token}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Mapbox Directions HTTP ${res.status}`);
  }
  const data = await res.json();

  if (data.code !== "Ok" || !data.routes?.length) {
    console.error("[mapbox] Directions error:", data.code, data.message);
    throw new Error(`Mapbox Directions error: ${data.code}`);
  }

  const route = data.routes[0];
  return {
    distance_km: Math.round((route.distance / 1000) * 10) / 10,
    duration_min: Math.round(route.duration / 60),
    polyline: route.geometry ?? null,
  };
}

/**
 * Get distance matrix between origins and destinations.
 * Mapbox Matrix API allows up to 25 coordinates total per request (driving profile).
 */
export async function getDistanceMatrix(
  origins: { lat: number; lng: number }[],
  destinations: { lat: number; lng: number }[],
): Promise<DistanceMatrixEntry[]> {
  const token = getToken();
  if (origins.length === 0 || destinations.length === 0) return [];

  const MAX_TOTAL = 25;
  const maxOriginsPerBatch = Math.max(1, MAX_TOTAL - destinations.length);
  const results: DistanceMatrixEntry[] = [];

  for (let i = 0; i < origins.length; i += maxOriginsPerBatch) {
    const batchOrigins = origins.slice(i, i + maxOriginsPerBatch);
    const coords = [...batchOrigins, ...destinations];
    const sourcesIdx = batchOrigins.map((_, idx) => idx).join(";");
    const destsIdx = destinations
      .map((_, idx) => batchOrigins.length + idx)
      .join(";");

    const url =
      `https://api.mapbox.com/directions-matrix/v1/mapbox/driving/${coordsParam(coords)}` +
      `?sources=${sourcesIdx}&destinations=${destsIdx}` +
      `&annotations=distance,duration&access_token=${token}`;

    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[mapbox] Matrix HTTP ${res.status}`);
      continue;
    }
    const data = await res.json();
    if (data.code !== "Ok") {
      console.error("[mapbox] Matrix error:", data.code, data.message);
      continue;
    }

    const distances: (number | null)[][] = data.distances || [];
    const durations: (number | null)[][] = data.durations || [];
    for (let r = 0; r < distances.length; r++) {
      for (let c = 0; c < distances[r].length; c++) {
        const dist = distances[r][c];
        const dur = durations[r]?.[c];
        if (dist == null || dur == null) continue;
        results.push({
          origin_index: i + r,
          destination_index: c,
          distance_km: Math.round((dist / 1000) * 10) / 10,
          duration_min: Math.round(dur / 60),
        });
      }
    }
  }

  return results;
}
