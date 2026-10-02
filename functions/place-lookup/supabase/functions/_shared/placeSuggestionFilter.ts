/**
 * Taxi pickup/drop-off autocomplete: filter admin noise, dedupe, rank by usefulness.
 * Mapbox Search Box `feature_type` values — type-based (not UK-only).
 */

export type MapboxFeatureType =
  | "country"
  | "region"
  | "postcode"
  | "district"
  | "place"
  | "city"
  | "locality"
  | "neighborhood"
  | "street"
  | "address"
  | "poi"
  | "category"
  | string;

export interface FilterablePlaceSuggestion {
  placeId: string;
  name: string;
  address: string;
  lat?: number;
  lng?: number;
  featureType?: MapboxFeatureType;
  source?: string;
  distanceMeters?: number;
}

/** Administrative / non-bookable types — hide from pickup/drop-off lists. */
const HIDDEN_FEATURE_TYPES = new Set([
  "country",
  "region",
  "district",
  "place",
  "city",
  "locality",
  "postcode",
]);

/** Bookable feature types for taxi stops. */
const ALLOWED_FEATURE_TYPES = new Set([
  "address",
  "street",
  "poi",
  "category",
  "neighborhood",
]);

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\s,]/g, "")
    .trim();
}

/** UK-style postcode detector (shared with client ukPostcode). */
export function isPostcodeLikeQuery(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 2 || t.length > 12) return false;
  const spaces = t.match(/\s/g)?.length ?? 0;
  if (spaces > 2) return false;
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length > 2) return false;
  const lettersOnlyWords = parts.filter((p) => /^[A-Za-z]+$/.test(p) && p.length >= 4);
  if (lettersOnlyWords.length >= 1 && parts.join(" ").length > 6) return false;
  const c = t.replace(/\s+/g, "").toUpperCase();
  if (c.length < 2 || c.length > 7) return false;
  if (!/^[A-Z]{1,2}\d/.test(c)) return false;
  if (!/^[A-Z0-9]+$/.test(c)) return false;
  return true;
}

export function isHiddenFeatureType(featureType: string | undefined): boolean {
  if (!featureType) return false;
  return HIDDEN_FEATURE_TYPES.has(featureType.toLowerCase());
}

export function isAllowedFeatureType(featureType: string | undefined): boolean {
  if (!featureType) return true;
  const t = featureType.toLowerCase();
  if (HIDDEN_FEATURE_TYPES.has(t)) return false;
  if (ALLOWED_FEATURE_TYPES.has(t)) return true;
  return false;
}

/** Drop city-only rows and comma-heavy admin labels (e.g. "Milton Keynes, City of…"). */
export function isAdminPlaceLabel(name: string, address: string, featureType?: string): boolean {
  if (featureType && isHiddenFeatureType(featureType)) return true;
  const combined = `${name} ${address}`.toLowerCase();
  const commaCount = (combined.match(/,/g) ?? []).length;
  if (commaCount >= 3 && !/\d/.test(name)) return true;
  if (/^(city of|borough of|county of|greater)\s/i.test(name)) return true;
  if (/\b(united kingdom|england|scotland|wales|northern ireland|germany|united states)\b/i.test(name)) {
    return true;
  }
  return false;
}

export function shouldKeepSuggestion(
  row: FilterablePlaceSuggestion,
  options?: { allowPostcodeCenter?: boolean },
): boolean {
  if (row.source === "onecab_place" || row.source === "mapbox_postcode" || row.source === "backend_postcode" || row.source === "synthetic_postcode") {
    if (row.source === "mapbox_postcode" || row.source === "backend_postcode" || row.source === "synthetic_postcode") {
      return options?.allowPostcodeCenter === true;
    }
    return true;
  }
  const ft = row.featureType?.toLowerCase();
  if (ft && isHiddenFeatureType(ft)) return false;
  if (isAdminPlaceLabel(row.name, row.address, ft)) return false;
  if (ft && !isAllowedFeatureType(ft)) return false;
  return (row.name || "").trim().length > 0;
}

function suggestionDedupeKey(row: FilterablePlaceSuggestion): string {
  const name = normalizeText(row.name);
  const addr = normalizeText(row.address);
  if (row.placeId && !row.placeId.startsWith("geocoded-")) return `id:${row.placeId}`;
  if (row.lat != null && row.lng != null && Number.isFinite(row.lat) && Number.isFinite(row.lng)) {
    return `coord:${row.lat.toFixed(5)},${row.lng.toFixed(5)}`;
  }
  return `label:${name}|${addr.slice(0, 48)}`;
}

export function dedupePlaceSuggestions<T extends FilterablePlaceSuggestion>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  let cityLevelKept = false;

  for (const row of rows) {
    const key = suggestionDedupeKey(row);
    if (seen.has(key)) continue;

    const ft = row.featureType?.toLowerCase();
    const isCityLevel = ft === "place" || ft === "locality" || ft === "city";
    if (isCityLevel) {
      if (cityLevelKept) continue;
      cityLevelKept = true;
    }

    const labelKey = normalizeText(`${row.name}|${row.address}`);
    if (seen.has(`label:${labelKey}`)) continue;

    seen.add(key);
    seen.add(`label:${labelKey}`);
    out.push(row);
  }
  return out;
}

function suggestionRank(row: FilterablePlaceSuggestion, isPostcodeQuery: boolean): number {
  const ft = (row.featureType || "").toLowerCase();
  if (row.source === "onecab_place") return 0;
  if (row.source === "synthetic_postcode") return isPostcodeQuery ? 5 : 75;
  if (row.source === "mapbox_postcode" || row.source === "backend_postcode") {
    return isPostcodeQuery ? 45 : 80;
  }
  const dist = row.distanceMeters;
  const distBoost =
    typeof dist === "number" && Number.isFinite(dist) ? Math.min(dist / 500, 40) : 0;
  if (ft === "poi") return 10 + distBoost;
  if (ft === "address") return 15 + distBoost;
  if (ft === "street") return 20 + distBoost;
  if (ft === "neighborhood") return 35 + distBoost;
  if (ft === "category") return 25 + distBoost;
  if (typeof dist === "number" && Number.isFinite(dist)) {
    return 30 + Math.min(dist / 100, 50);
  }
  return 50;
}

export function sortPlaceSuggestions<T extends FilterablePlaceSuggestion>(
  rows: T[],
  isPostcodeQuery: boolean,
): T[] {
  return [...rows].sort((a, b) => {
    const ra = suggestionRank(a, isPostcodeQuery);
    const rb = suggestionRank(b, isPostcodeQuery);
    if (ra !== rb) return ra - rb;
    const da = a.distanceMeters ?? Infinity;
    const db = b.distanceMeters ?? Infinity;
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name);
  });
}

export function filterPlaceSuggestions<T extends FilterablePlaceSuggestion>(
  rows: T[],
  options?: { isPostcodeQuery?: boolean; maxResults?: number },
): T[] {
  const isPostcodeQuery = options?.isPostcodeQuery === true;
  const max = options?.maxResults ?? 8;
  const filtered = rows.filter((r) =>
    shouldKeepSuggestion(r, { allowPostcodeCenter: isPostcodeQuery }),
  );
  const deduped = dedupePlaceSuggestions(filtered);
  const sorted = sortPlaceSuggestions(deduped, isPostcodeQuery);
  return sorted.slice(0, max);
}

export function mergePlaceSuggestions<T extends FilterablePlaceSuggestion>(
  primary: T[],
  secondary: T[],
  options?: { isPostcodeQuery?: boolean; maxResults?: number },
): T[] {
  return filterPlaceSuggestions([...primary, ...secondary], options);
}

/** Haversine distance in metres (for ranking nearby results). */
export function distanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** GeoJSON Polygon → Mapbox `minLon,minLat,maxLon,maxLat` bbox string. */
export function geoBoundaryToBbox(geo: unknown): string | null {
  if (!geo || typeof geo !== "object") return null;
  const g = geo as { type?: string; coordinates?: unknown };
  if (g.type !== "Polygon" || !Array.isArray(g.coordinates)) return null;
  const ring = g.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 3) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const pt of ring) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const lon = Number(pt[0]);
    const lat = Number(pt[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  if (!Number.isFinite(minLon)) return null;
  return `${minLon},${minLat},${maxLon},${maxLat}`;
}

/** Short category-style queries (e.g. "hospital") that need bbox + distance ranking. */
export function isGenericPoiQuery(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 3 || isPostcodeLikeQuery(t)) return false;
  if (/\d/.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length <= 2;
}

/** Road / building queries (e.g. "800 Secklow Gate") — boost forward street+address geocode. */
export function isStreetLikeQuery(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 3 || isPostcodeLikeQuery(t)) return false;
  if (isGenericPoiQuery(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return true;
  return /\d/.test(t);
}

export function mapMapboxSuggestToRow(f: {
  mapbox_id: string;
  name: string;
  name_preferred?: string;
  place_formatted?: string;
  full_address?: string;
  feature_type?: string;
  address?: string;
  distance?: number;
}): FilterablePlaceSuggestion & { placeId: string; lat: number; lng: number; source: "mapbox" } {
  const name = (f.name_preferred || f.name || "").trim();
  const address = (f.place_formatted || f.full_address || f.address || "").trim();
  const distanceMeters =
    typeof f.distance === "number" && Number.isFinite(f.distance) ? f.distance : undefined;
  return {
    placeId: f.mapbox_id,
    name,
    address,
    lat: 0,
    lng: 0,
    featureType: f.feature_type,
    source: "mapbox",
    distanceMeters,
  };
}

export function formatPlaceSuggestionDisplay(name: string, address: string): { name: string; address: string } {
  const main = name.trim();
  const secondary = address.trim();
  if (!main) return { name: secondary, address: "" };
  if (!secondary || secondary.toLowerCase().startsWith(main.toLowerCase())) {
    return { name: main, address: secondary };
  }
  if (secondary.toLowerCase().includes(main.toLowerCase()) && secondary.length > main.length) {
    return { name: main, address: secondary };
  }
  return { name: main, address: secondary };
}
