/**
 * Shared Google Maps API helpers for Edge Functions.
 * Uses the server-side GOOGLE_MAPS_API_KEY secret.
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

function getApiKey(): string {
  const key = Deno.env.get("GOOGLE_MAPS_API_KEY");
  if (!key) throw new Error("GOOGLE_MAPS_API_KEY secret is not configured");
  return key;
}

/**
 * Get driving directions between two points.
 * Returns distance in km, duration in minutes, and encoded polyline.
 */
export async function getDirections(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number,
  waypoints?: { lat: number; lng: number }[]
): Promise<DirectionsResult> {
  const apiKey = getApiKey();
  const origin = `${originLat},${originLng}`;
  const destination = `${destLat},${destLng}`;

  let url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${destination}&mode=driving&key=${apiKey}`;

  if (waypoints && waypoints.length > 0) {
    const wp = waypoints.map((w) => `${w.lat},${w.lng}`).join("|");
    url += `&waypoints=${encodeURIComponent(wp)}`;
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Google Directions API HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.status !== "OK" || !data.routes?.length) {
    console.error("[googleMaps] Directions API status:", data.status, data.error_message);
    throw new Error(`Directions API error: ${data.status}`);
  }

  const route = data.routes[0];
  const legs = route.legs as Array<{ distance: { value: number }; duration: { value: number } }>;

  const totalDistanceM = legs.reduce((sum: number, leg: any) => sum + leg.distance.value, 0);
  const totalDurationS = legs.reduce((sum: number, leg: any) => sum + leg.duration.value, 0);

  return {
    distance_km: Math.round((totalDistanceM / 1000) * 10) / 10,
    duration_min: Math.round(totalDurationS / 60),
    polyline: route.overview_polyline?.points ?? null,
  };
}

/**
 * Get distance matrix between multiple origins and a single destination.
 * Useful for finding ETAs from multiple drivers to a pickup point.
 */
export async function getDistanceMatrix(
  origins: { lat: number; lng: number }[],
  destinations: { lat: number; lng: number }[]
): Promise<DistanceMatrixEntry[]> {
  const apiKey = getApiKey();

  if (origins.length === 0 || destinations.length === 0) return [];

  // Google limits to 25 origins × 25 destinations per request
  const MAX_ORIGINS = 25;
  const results: DistanceMatrixEntry[] = [];

  for (let i = 0; i < origins.length; i += MAX_ORIGINS) {
    const batch = origins.slice(i, i + MAX_ORIGINS);
    const originsStr = batch.map((o) => `${o.lat},${o.lng}`).join("|");
    const destsStr = destinations.map((d) => `${d.lat},${d.lng}`).join("|");

    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(originsStr)}&destinations=${encodeURIComponent(destsStr)}&mode=driving&key=${apiKey}`;

    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[googleMaps] Distance Matrix HTTP ${res.status}`);
      continue;
    }

    const data = await res.json();

    if (data.status !== "OK") {
      console.error("[googleMaps] Distance Matrix status:", data.status, data.error_message);
      continue;
    }

    for (let r = 0; r < data.rows.length; r++) {
      for (let c = 0; c < data.rows[r].elements.length; c++) {
        const el = data.rows[r].elements[c];
        if (el.status === "OK") {
          results.push({
            origin_index: i + r,
            destination_index: c,
            distance_km: Math.round((el.distance.value / 1000) * 10) / 10,
            duration_min: Math.round(el.duration.value / 60),
          });
        }
      }
    }
  }

  return results;
}
