/**
 * Global ONECAB location-search SSOT (provider-independent).
 * Mapbox = display only. Google Places = external search (backend). Landmarks = local.
 */

export type LocationSearchBookingContext =
  | "CUSTOMER_APP"
  | "DRIVER_APP"
  | "ADMIN_BOOKING"
  | "CORPORATE_BOOKING"
  | "GUEST_BOOKING";

export type LocationSearchSource =
  | "ONECAB_LANDMARK"
  | "GOOGLE_PLACES"
  | "CURRENT_LOCATION"
  | "MAP_PIN"
  | "SAVED_LOCATION"
  | "CORPORATE_SAVED";

export type OnecabLocationResult = {
  id: string;
  source: LocationSearchSource;
  provider_place_id: string | null;
  display_name: string;
  short_name: string;
  address_text: string;
  latitude: number;
  longitude: number;
  category: string | null;
  country_code: string | null;
  region_id: string | null;
  service_area_id: string | null;
  inside_service_area: boolean;
  distance_from_search_centre_metres: number | null;
  is_verified_local_landmark: boolean;
  /** Optional — used to skip Google when query exactly matches an alt name. */
  alternative_names?: string[];
};

export const LOCATION_SEARCH_MIN_QUERY_LENGTH = 3;
export const LOCATION_SEARCH_DEBOUNCE_MS = 400;
export const LOCATION_SEARCH_MAX_RESULTS = 8;
export const LOCATION_SEARCH_EDGE_FN = "search-onecab-locations";

export const LOCATION_SEARCH_GOOGLE_UNAVAILABLE_MESSAGE =
  "Online place search is temporarily unavailable. Choose a saved location or select the location on the map.";

export function shouldCallExternalLocationSearch(query: string, minLength = LOCATION_SEARCH_MIN_QUERY_LENGTH): boolean {
  return query.trim().length >= minLength;
}

export function haversineMetres(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export function pointInBbox(
  lat: number,
  lng: number,
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null,
): boolean {
  if (!bbox) return true;
  return lat >= bbox.minLat && lat <= bbox.maxLat && lng >= bbox.minLng && lng <= bbox.maxLng;
}

/** Near = inside bbox OR within pad metres of centre. */
export function isInsideOrNearServiceArea(args: {
  lat: number;
  lng: number;
  centreLat: number | null;
  centreLng: number | null;
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null;
  nearPadMetres?: number;
}): { inside: boolean; near: boolean; distanceMetres: number | null } {
  const pad = args.nearPadMetres ?? 25_000;
  const inside = pointInBbox(args.lat, args.lng, args.bbox);
  let distanceMetres: number | null = null;
  if (args.centreLat != null && args.centreLng != null) {
    distanceMetres = haversineMetres(args.centreLat, args.centreLng, args.lat, args.lng);
  }
  const near = inside || (distanceMetres != null && distanceMetres <= pad);
  return { inside, near, distanceMetres };
}

export function normalizeCountryCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const u = String(raw).trim().toUpperCase();
  if (u === "UK") return "GB";
  if (/^[A-Z]{2}$/.test(u)) return u;
  return null;
}

export function exactNameMatch(query: string, name: string): boolean {
  return name.trim().toLowerCase() === query.trim().toLowerCase();
}

export function rankLocationSearchResults(
  results: OnecabLocationResult[],
  query: string,
): OnecabLocationResult[] {
  const q = query.trim().toLowerCase();
  const scored = results.map((r) => {
    let tier = 50;
    if (r.source === "CORPORATE_SAVED") tier = 5;
    else if (r.source === "ONECAB_LANDMARK" && r.is_verified_local_landmark) {
      tier = exactNameMatch(q, r.display_name) || exactNameMatch(q, r.short_name) ? 10 : 15;
    } else if (r.source === "GOOGLE_PLACES" && r.inside_service_area) tier = 20;
    else if (r.source === "GOOGLE_PLACES") tier = 30;
    else if (r.source === "CURRENT_LOCATION") tier = 40;
    else if (r.source === "MAP_PIN") tier = 45;
    else if (r.source === "SAVED_LOCATION") tier = 12;

    const name = r.display_name.toLowerCase();
    let nameScore = 0;
    if (name === q) nameScore = 100;
    else if (name.startsWith(q)) nameScore = 80;
    else if (name.includes(q)) nameScore = 50;

    const dist = r.distance_from_search_centre_metres ?? 9_999_999;
    return { r, tier, nameScore, dist };
  });

  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.nameScore !== b.nameScore) return b.nameScore - a.nameScore;
    if (a.dist !== b.dist) return a.dist - b.dist;
    return a.r.display_name.localeCompare(b.r.display_name);
  });

  return scored.map((s) => s.r);
}

export function hasStrongExactLandmarkMatch(
  landmarks: OnecabLocationResult[],
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return landmarks.some((l) => {
    if (l.source !== "ONECAB_LANDMARK" || !l.is_verified_local_landmark) return false;
    if (l.display_name.toLowerCase() === q || l.short_name.toLowerCase() === q) return true;
    return (l.alternative_names ?? []).some((a) => String(a).trim().toLowerCase() === q);
  });
}

export function parseOnecabLocationResults(raw: unknown): OnecabLocationResult[] {
  if (!Array.isArray(raw)) return [];
  const out: OnecabLocationResult[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const lat = Number(row.latitude);
    const lng = Number(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const display = String(row.display_name ?? "").trim();
    if (!display) continue;
    out.push({
      id: String(row.id ?? `${lat},${lng}`),
      source: (row.source as LocationSearchSource) ?? "GOOGLE_PLACES",
      provider_place_id: row.provider_place_id == null ? null : String(row.provider_place_id),
      display_name: display,
      short_name: String(row.short_name ?? display),
      address_text: String(row.address_text ?? display),
      latitude: lat,
      longitude: lng,
      category: row.category == null ? null : String(row.category),
      country_code: normalizeCountryCode(row.country_code as string | null),
      region_id: row.region_id == null ? null : String(row.region_id),
      service_area_id: row.service_area_id == null ? null : String(row.service_area_id),
      inside_service_area: Boolean(row.inside_service_area),
      distance_from_search_centre_metres:
        row.distance_from_search_centre_metres == null
          ? null
          : Number(row.distance_from_search_centre_metres),
      is_verified_local_landmark: Boolean(row.is_verified_local_landmark),
    });
  }
  return out;
}

/** Convert SSOT result → legacy PlaceResult-ish shape used by customer autocomplete. */
export function toLegacyPlaceSuggestion(r: OnecabLocationResult): {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  source: string;
  category?: string;
  badge?: string;
  distanceMeters?: number;
  countryCode?: string;
} {
  return {
    placeId: r.provider_place_id ?? r.id,
    name: r.short_name || r.display_name,
    address: r.address_text || r.display_name,
    lat: r.latitude,
    lng: r.longitude,
    source:
      r.source === "ONECAB_LANDMARK"
        ? "onecab_place"
        : r.source === "GOOGLE_PLACES"
          ? "google_places"
          : r.source.toLowerCase(),
    category: r.category ?? undefined,
    badge: r.is_verified_local_landmark ? "ONECAB" : undefined,
    distanceMeters: r.distance_from_search_centre_metres ?? undefined,
    countryCode: r.country_code ?? undefined,
  };
}

export function geoBoundaryToBbox(geoBoundary: unknown): {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
} | null {
  if (!Array.isArray(geoBoundary) || geoBoundary.length < 3) return null;
  let minLat = 90;
  let maxLat = -90;
  let minLng = 180;
  let maxLng = -180;
  for (const pt of geoBoundary) {
    if (!pt || typeof pt !== "object") continue;
    const p = pt as Record<string, unknown>;
    const lat = Number(p.lat ?? p.latitude);
    const lng = Number(p.lng ?? p.lon ?? p.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  }
  if (minLat > maxLat || minLng > maxLng) return null;
  return { minLat, maxLat, minLng, maxLng };
}
