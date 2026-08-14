import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/corsHeaders.ts";
import {
  distanceMeters,
  filterPlaceSuggestions,
  geoBoundaryToBbox,
  isGenericPoiQuery,
  isPostcodeLikeQuery,
  isStreetLikeQuery,
  mapMapboxSuggestToRow,
} from "../../../shared/placeSuggestionFilter.ts";
import {
  extractUkPostcodeFromText,
  normalizeUkPostcodeQuery,
  ukOutwardAreasMatch,
} from "../../../shared/ukPostcodeSearch.ts";
import {
  choosePinnedPoi,
  looksLikeStreetAddressName,
  normalizeV6StreetAddress,
} from "../../../shared/pinnedPoiSelection.ts";

/**
 * place-lookup — Mapbox-backed.
 *
 * The customer app no longer uses Google Maps on the client. This function preserves
 * the historical request/response shape (autocomplete / placeId resolution / address
 * geocoding / reverseGeocode) so existing callers do not need to change, but powers
 * everything with the Mapbox Search Box + Geocoding APIs.
 *
 * Google is intentionally retained ONLY in calculate-route (distance/ETA/fare math).
 */

interface LocationBias {
  lat: number;
  lng: number;
  radiusMeters?: number;
}

interface PlaceLookupRequest {
  placeId?: string;
  address?: string;
  lat?: number;
  lng?: number;
  reverseGeocode?: boolean;
  sessionToken?: string;
  autocomplete?: boolean;
  locationBias?: LocationBias;
  countryCode?: string;
  resultTypes?: string[];
  serviceAreaId?: string;
}

interface PlaceSuggestion {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  source?: "onecab_place" | "mapbox";
  featureType?: string;
  distanceMeters?: number;
  category?: string;
  icon?: string;
  badge?: string;
}

interface AddressComponents {
  street?: string;
  route?: string;
  locality?: string;
  post_town?: string;
  place?: string;
}

interface PlaceLookupResponse {
  success: boolean;
  lat?: number;
  lng?: number;
  formattedAddress?: string;
  address?: string;
  name?: string;
  placeId?: string;
  addressComponents?: AddressComponents;
  featureType?: string;
  countryCode?: string;
  suggestions?: PlaceSuggestion[];
  error?: string;
  errorCode?: string;
}

/** Map Mapbox Geocoding v6 `context` into delivery-header-friendly parts. */
function mapMapboxContextToComponents(
  context: Record<string, { name?: string }> | undefined,
): AddressComponents | undefined {
  if (!context) return undefined;
  const streetName = context.street?.name?.trim();
  const addressNumber = context.address?.name?.trim();
  const route = streetName || undefined;
  const street =
    addressNumber && streetName
      ? `${addressNumber} ${streetName}`
      : streetName || addressNumber || undefined;
  const locality = context.locality?.name?.trim();
  const postTown = context.district?.name?.trim() || context.region?.name?.trim();
  const place = context.place?.name?.trim();
  if (!street && !route && !locality && !postTown && !place) return undefined;
  return {
    street,
    route,
    locality,
    post_town: postTown,
    place,
  };
}


/**
 * Generic one-word POI queries ("hospital", "airport", "station") must return
 * places near the rider — not famous far-away cities. When we have a real
 * proximity (GPS or service-area centre, not the London fallback) and no
 * service-area bbox, constrain the Mapbox search to a box of this radius so
 * London/Birmingham results are excluded for a rider in e.g. Milton Keynes.
 */
const GENERIC_POI_BBOX_RADIUS_KM = 40;
const POSTCODE_SEARCH_BBOX_RADIUS_KM = 45;

/** Build a Mapbox `minLon,minLat,maxLon,maxLat` bbox of ~radiusKm around a point. */
function bboxAroundPoint(lat: number, lng: number, radiusKm: number): string {
  const latDelta = radiusKm / 111;
  const cos = Math.cos((lat * Math.PI) / 180);
  const lngDelta = radiusKm / (111 * (Math.abs(cos) > 1e-6 ? cos : 1e-6));
  const minLat = Math.max(-90, lat - latDelta);
  const maxLat = Math.min(90, lat + latDelta);
  const minLng = Math.max(-180, lng - Math.abs(lngDelta));
  const maxLng = Math.min(180, lng + Math.abs(lngDelta));
  return `${minLng},${minLat},${maxLng},${maxLat}`;
}

interface ServiceAreaBias {
  centerLat: number;
  centerLng: number;
  bbox: string | null;
  name: string | null;
  country: string | null;
}

/**
 * Module-level service area bias cache — per Deno isolate, lives ~5 min.
 * Service areas change rarely (admin ops only) so this is safe and saves a serial
 * DB round-trip on every autocomplete keystroke when serviceAreaId is supplied.
 */
const SERVICE_AREA_BIAS_CACHE_TTL_MS = 5 * 60_000;
const serviceAreaBiasCache = new Map<string, { bias: ServiceAreaBias | null; expiresAt: number }>();

async function fetchServiceAreaBias(
  serviceAreaId: string,
  // Supabase's edge-client fluent query type is hard to express across esm.sh/Deno versions.
  // deno-lint-ignore no-explicit-any
  sb: any,
): Promise<ServiceAreaBias | null> {
  const cached = serviceAreaBiasCache.get(serviceAreaId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.bias;
  }

  const { data, error } = await sb
    .from("service_areas")
    .select("center_lat, center_lng, geo_boundary, name, country")
    .eq("id", serviceAreaId)
    .eq("is_active", true)
    .maybeSingle();
  if (error || !data) {
    serviceAreaBiasCache.set(serviceAreaId, { bias: null, expiresAt: Date.now() + SERVICE_AREA_BIAS_CACHE_TTL_MS });
    return null;
  }
  const centerLat = Number(data.center_lat);
  const centerLng = Number(data.center_lng);
  if (!Number.isFinite(centerLat) || !Number.isFinite(centerLng)) {
    serviceAreaBiasCache.set(serviceAreaId, { bias: null, expiresAt: Date.now() + SERVICE_AREA_BIAS_CACHE_TTL_MS });
    return null;
  }
  const bias: ServiceAreaBias = {
    centerLat,
    centerLng,
    bbox: geoBoundaryToBbox(data.geo_boundary),
    name: typeof data.name === "string" ? data.name : null,
    country: typeof data.country === "string" ? data.country : null,
  };
  serviceAreaBiasCache.set(serviceAreaId, { bias, expiresAt: Date.now() + SERVICE_AREA_BIAS_CACHE_TTL_MS });
  return bias;
}

async function fetchForwardGeocodeSuggestions(
  query: string,
  proximityLng: number | undefined,
  proximityLat: number | undefined,
  token: string,
  country: string,
  bbox: string | null,
  types: string,
  limit = 6,
): Promise<PlaceSuggestion[]> {
  const params = new URLSearchParams({
    q: query,
    access_token: token,
    limit: String(limit),
    types,
    language: "en",
  });
  const hasProximity = isFiniteCoord(proximityLng) && isFiniteCoord(proximityLat);
  if (hasProximity) params.set("proximity", `${proximityLng},${proximityLat}`);
  if (country) params.set("country", country);
  if (bbox) params.set("bbox", bbox);

  const r = await fetch(`https://api.mapbox.com/search/geocode/v6/forward?${params}`);
  const data = await r.json();
  if (!r.ok || !Array.isArray(data.features)) return [];

  return data.features
    .map((f: {
      geometry?: { coordinates?: [number, number] };
      properties?: {
        mapbox_id?: string;
        name?: string;
        full_address?: string;
        place_formatted?: string;
        feature_type?: string;
      };
    }) => {
      const coords = f.geometry?.coordinates;
      const flng = coords?.[0];
      const flat = coords?.[1];
      const p = f.properties ?? {};
      const dist =
        hasProximity && typeof flat === "number" && typeof flng === "number"
          ? distanceMeters(proximityLat!, proximityLng!, flat, flng)
          : undefined;
      return {
        placeId: p.mapbox_id || `${flat},${flng}`,
        name: (p.name || "").trim(),
        address: (p.place_formatted || p.full_address || "").trim(),
        lat: typeof flat === "number" ? flat : 0,
        lng: typeof flng === "number" ? flng : 0,
        featureType: p.feature_type || "address",
        distanceMeters: dist,
        source: "mapbox" as const,
      };
    })
    .filter((row: PlaceSuggestion) => row.name.length > 0);
}

async function fetchForwardPoiSuggestions(
  query: string,
  proximityLng: number | undefined,
  proximityLat: number | undefined,
  token: string,
  country: string,
  bbox: string | null,
): Promise<PlaceSuggestion[]> {
  return fetchForwardGeocodeSuggestions(
    query,
    proximityLng,
    proximityLat,
    token,
    country,
    bbox,
    "place,locality,address",
    6,
  );
}

async function fetchForwardStreetSuggestions(
  query: string,
  proximityLng: number | undefined,
  proximityLat: number | undefined,
  token: string,
  country: string,
  bbox: string | null,
): Promise<PlaceSuggestion[]> {
  return fetchForwardGeocodeSuggestions(
    query,
    proximityLng,
    proximityLat,
    token,
    country,
    bbox,
    "address,street",
    6,
  );
}

function isFiniteCoord(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function logAddressSearch(event: string, detail: Record<string, unknown>): void {
  console.log(`[OneCabAddressSearch] ${event} ${JSON.stringify(detail)}`);
  if (event === "ADDRESS_QUERY") {
    console.log(`[OneCabAddressSuggestions] ADDRESS_SUGGESTIONS_QUERY ${JSON.stringify(detail)}`);
  }
  if (event === "ADDRESS_RESULT_RANK") {
    console.log(`[OneCabAddressSuggestions] ADDRESS_SUGGESTIONS_RESULTS ${JSON.stringify(detail)}`);
  }
}

function jsonResponse(payload: PlaceLookupResponse, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeUkPostcodeForGeocode(input: string): string {
  return normalizeUkPostcodeQuery(input);
}

function suggestionLooksLikeForeignPostcode(name: string, address: string, query: string): boolean {
  const pc = extractUkPostcodeFromText(name) || extractUkPostcodeFromText(address);
  if (!pc) return false;
  return !ukOutwardAreasMatch(query, pc);
}

async function geocodePostcodeCenter(
  query: string,
  token: string,
  country: string,
  proximityLat?: number,
  proximityLng?: number,
): Promise<{ lat: number; lng: number } | null> {
  const normalized = normalizeUkPostcodeForGeocode(query);
  const params = new URLSearchParams({
    q: normalized,
    access_token: token,
    limit: "5",
    types: "postcode",
  });
  if (country) params.set("country", country);
  if (
    typeof proximityLat === "number" &&
    typeof proximityLng === "number" &&
    Number.isFinite(proximityLat) &&
    Number.isFinite(proximityLng)
  ) {
    params.set("proximity", `${proximityLng},${proximityLat}`);
    params.set("bbox", bboxAroundPoint(proximityLat, proximityLng, POSTCODE_SEARCH_BBOX_RADIUS_KM));
  }
  const r = await fetch(`https://api.mapbox.com/search/geocode/v6/forward?${params}`);
  const data = await r.json();
  if (!Array.isArray(data.features)) return null;

  for (const f of data.features) {
    const coords = f.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const p = f.properties ?? {};
    const label = normalizeUkPostcodeForGeocode(
      p.context?.postcode?.name || p.name_preferred || p.name || normalized,
    );
    if (!ukOutwardAreasMatch(query, label)) continue;
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    return { lat, lng };
  }
  return null;
}

const UK_POSTCODE_IN_TEXT_RE =
  /\b(GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/i;

function buildForwardGeocodeQueries(address: string): string[] {
  const trimmed = address.trim();
  const queries: string[] = [];
  const add = (q: string) => {
    const next = q.trim();
    if (!next) return;
    if (!queries.some((existing) => existing.toLowerCase() === next.toLowerCase())) {
      queries.push(next);
    }
  };

  add(trimmed);
  add(trimmed.replace(/,?\s*(united kingdom|uk|great britain|england)\s*$/i, "").trim());

  const postcodeMatch = trimmed.match(UK_POSTCODE_IN_TEXT_RE);
  const postcode = postcodeMatch ? normalizeUkPostcodeForGeocode(postcodeMatch[0]) : "";
  const lead = trimmed.split(",")[0]?.trim() ?? "";
  if (lead && postcode) {
    add(`${lead}, ${postcode}`);
    add(`${lead} ${postcode}`);
    add(`${lead}, Milton Keynes, ${postcode}`);
  }
  if (postcode) add(postcode);

  return queries;
}

async function forwardGeocodeOnce(
  query: string,
  token: string,
  country: string,
  biasLat: number,
  biasLng: number,
  types: string,
  bbox: string | null,
): Promise<{
  lat: number;
  lng: number;
  name: string;
  formattedAddress: string;
  placeId: string;
} | null> {
  const params = new URLSearchParams({
    q: query,
    access_token: token,
    limit: "1",
    types,
    proximity: `${biasLng},${biasLat}`,
  });
  if (country) params.set("country", country);
  if (bbox) params.set("bbox", bbox);

  const r = await fetch(`https://api.mapbox.com/search/geocode/v6/forward?${params}`);
  const data = await r.json();
  if (!r.ok || !data.features?.[0]) return null;

  const f = data.features[0];
  const [flng, flat] = f.geometry.coordinates;
  const p = f.properties || {};
  const name = p.name || (p.full_address || query).split(",")[0];
  return {
    lat: flat,
    lng: flng,
    name,
    formattedAddress: p.full_address || p.place_formatted || name,
    placeId: p.mapbox_id || `${flat},${flng}`,
  };
}

async function resolveForwardGeocode(
  address: string,
  token: string,
  country: string,
  biasLat: number,
  biasLng: number,
  suggestBbox: string | null,
  geocodeTypesCsv: string,
): Promise<{
  lat: number;
  lng: number;
  name: string;
  formattedAddress: string;
  placeId: string;
} | null> {
  const queries = buildForwardGeocodeQueries(address);
  const typeSets = [
    geocodeTypesCsv.includes("poi") ? geocodeTypesCsv : `${geocodeTypesCsv},poi`,
    geocodeTypesCsv,
    "address,street,poi,place,locality",
  ];
  const bboxOptions = suggestBbox ? [suggestBbox, null] : [null];

  for (const q of queries) {
    for (const types of typeSets) {
      for (const bbox of bboxOptions) {
        const hit = await forwardGeocodeOnce(q, token, country, biasLat, biasLng, types, bbox);
        if (hit) return hit;
      }
    }
  }
  return null;
}

async function fetchNearbyBookablePlaces(
  lat: number,
  lng: number,
  token: string,
  _session: string,
  country: string,
): Promise<PlaceSuggestion[]> {
  const params = new URLSearchParams({
    longitude: String(lng),
    latitude: String(lat),
    access_token: token,
    language: "en",
    types: "poi,address,street,place,locality",
    limit: "10",
  });
  if (country) params.set("country", country);
  const r = await fetch(`https://api.mapbox.com/search/searchbox/v1/reverse?${params}`);
  const data = await r.json();
  if (!r.ok || !Array.isArray(data.features)) {
    if (!r.ok) {
      console.warn("[place-lookup] searchbox reverse failed:", r.status, data?.message?.error ?? data);
    }
    return [];
  }

  return mapSearchboxReverseFeatures(lat, lng, data.features);
}

function mapSearchboxReverseFeatures(
  lat: number,
  lng: number,
  features: Array<{
    properties?: {
      mapbox_id?: string;
      name?: string;
      name_preferred?: string;
      place_formatted?: string;
      full_address?: string;
      feature_type?: string;
      address?: string;
    };
    geometry?: { coordinates?: [number, number] };
  }>,
): PlaceSuggestion[] {
  return features
    .map((f) => {
      const p = f.properties ?? {};
      const coords = f.geometry?.coordinates;
      const flng = coords?.[0];
      const flat = coords?.[1];
      const dist =
        typeof flat === "number" && typeof flng === "number"
          ? distanceMeters(lat, lng, flat, flng)
          : undefined;
      const streetLine = (p.address || "").trim();
      const formattedTail = (p.place_formatted || p.full_address || "").trim();
      const address = streetLine && formattedTail && !formattedTail.toLowerCase().startsWith(streetLine.toLowerCase())
        ? `${streetLine}, ${formattedTail}`
        : formattedTail || streetLine;
      return {
        placeId: p.mapbox_id || `${flat},${flng}`,
        name: (p.name_preferred || p.name || "").trim(),
        address,
        lat: typeof flat === "number" ? flat : 0,
        lng: typeof flng === "number" ? flng : 0,
        featureType: p.feature_type,
        distanceMeters: dist,
        source: "mapbox" as const,
      };
    })
    .filter((row: PlaceSuggestion) => row.name.length > 0);
}

async function fetchNearbyCategoryPois(
  lat: number,
  lng: number,
  token: string,
  country: string,
): Promise<PlaceSuggestion[]> {
  const categories = ["supermarket", "shopping_mall", "fast_food", "restaurant"];
  const rows: PlaceSuggestion[] = [];

  for (const category of categories) {
    const params = new URLSearchParams({
      proximity: `${lng},${lat}`,
      access_token: token,
      language: "en",
      limit: "10",
    });
    if (country) params.set("country", country);
    const r = await fetch(`https://api.mapbox.com/search/searchbox/v1/category/${category}?${params}`);
    const data = await r.json();
    if (!r.ok || !Array.isArray(data.features)) continue;
    rows.push(...mapSearchboxReverseFeatures(lat, lng, data.features).map((row) => ({
      ...row,
      featureType: row.featureType || "poi",
      category,
    })));
  }

  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.name.toLowerCase()}|${row.placeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface V6ReverseSnapshot {
  name: string;
  formattedAddress: string;
  featureType?: string;
  addressComponents?: AddressComponents;
  countryCode?: string;
}

async function fetchV6ReverseSnapshot(
  lat: number,
  lng: number,
  token: string,
  country: string,
): Promise<V6ReverseSnapshot | null> {
  const params = new URLSearchParams({
    longitude: String(lng),
    latitude: String(lat),
    access_token: token,
    limit: "1",
  });
  if (country) params.set("country", country);
  const r = await fetch(`https://api.mapbox.com/search/geocode/v6/reverse?${params}`);
  const data = await r.json();
  if (!r.ok) return null;
  const f = data.features?.[0];
  if (!f) return null;
  const p = f.properties || {};
  const rawName = p.name || (p.full_address || "").split(",")[0] || "";
  const contextObj = p.context as Record<string, any> | undefined;
  return {
    name: deduplicateRepeatedStreetSuffix(rawName),
    formattedAddress: deduplicateFormattedAddress(p.full_address || p.place_formatted || rawName),
    featureType: p.feature_type,
    addressComponents: mapMapboxContextToComponents(contextObj),
    countryCode: contextObj?.country?.country_code,
  };
}

function enrichPinnedPoiAddress(poi: { name: string; address: string }, v6: V6ReverseSnapshot | null): string {
  const existing = poi.address.trim();
  const v6Street =
    v6?.addressComponents?.street?.trim() ||
    (v6?.name && looksLikeStreetAddressName(v6.name) ? deduplicateRepeatedStreetSuffix(v6.name) : "");

  if (!v6Street) return deduplicateFormattedAddress(existing || poi.name);

  const lead = existing.split(",")[0]?.trim() || "";
  if (lead && /^\d/.test(lead)) return deduplicateFormattedAddress(existing || v6Street);

  const tail = existing.includes(",")
    ? existing.split(",").slice(1).join(",").trim()
    : existing.replace(/^[A-Za-z\s]+$/i, "").trim();

  if (tail && !v6Street.toLowerCase().includes(tail.toLowerCase())) {
    return deduplicateFormattedAddress(`${v6Street}, ${tail}`);
  }
  return deduplicateFormattedAddress(v6Street);
}

function deduplicateRepeatedStreetSuffix(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return text;
  const match = text.match(/^(\d+\s+)?(.+)\s+\2$/i);
  if (!match) return text;
  const house = match[1] ?? "";
  return `${house}${match[2].trim()}`.replace(/\s+/g, " ").trim();
}

function deduplicateFormattedAddress(value: string): string {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return deduplicateRepeatedStreetSuffix(value);
  parts[0] = deduplicateRepeatedStreetSuffix(parts[0]);
  return parts.join(", ");
}

function buildPinnedPoiFormattedAddress(name: string, address: string): string {
  const cleanName = name.trim();
  const cleanAddress = address.trim();
  if (!cleanName) return cleanAddress;
  if (!cleanAddress) return cleanName;
  const addressLower = cleanAddress.toLowerCase();
  if (addressLower === cleanName.toLowerCase() || addressLower.startsWith(`${cleanName.toLowerCase()},`)) {
    return cleanAddress;
  }
  return [cleanName, cleanAddress].join(", ");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const token = Deno.env.get("MAPBOX_PUBLIC_TOKEN");
    if (!token) {
      console.error("[place-lookup] MAPBOX_PUBLIC_TOKEN not configured");
      return jsonResponse(
        { success: false, error: "Mapbox token not configured", errorCode: "KEY_MISSING" },
        500,
      );
    }

    const body = (await req.json().catch(() => ({}))) as PlaceLookupRequest;
    const { placeId, address, lat, lng, reverseGeocode, sessionToken, autocomplete, locationBias, countryCode, resultTypes, serviceAreaId } = body;

    // ---------- Resolve ONECAB custom place id (prefix: onecab:<uuid>) ----------
    if (placeId && placeId.startsWith("onecab:")) {
      const id = placeId.slice("onecab:".length);
      const supaUrl = Deno.env.get("SUPABASE_URL");
      const supaKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY");
      if (supaUrl && supaKey) {
        const sb = createClient(supaUrl, supaKey);
        const { data, error } = await sb
          .from("places")
          .select("id, name, display_name, address, postcode, latitude, longitude, category, icon")
          .eq("id", id)
          .eq("is_active", true)
          .maybeSingle();
        if (!error && data) {
          return jsonResponse({
            success: true,
            lat: data.latitude,
            lng: data.longitude,
            formattedAddress: data.address,
            name: data.display_name || data.name,
            placeId: `onecab:${data.id}`,
          });
        }
      }
    }

    const supaUrl = Deno.env.get("SUPABASE_URL");
    const supaKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY");
    const sb = supaUrl && supaKey ? createClient(supaUrl, supaKey) : null;

    const session = sessionToken || crypto.randomUUID();

    let serviceAreaBias: ServiceAreaBias | null = null;
    if (serviceAreaId && sb) {
      try {
        serviceAreaBias = await fetchServiceAreaBias(serviceAreaId, sb);
      } catch (e) {
        console.warn("[place-lookup] service area bias lookup failed:", e instanceof Error ? e.message : e);
      }
    }

    const effectiveBiasLat = reverseGeocode ? lat : locationBias?.lat;
    const effectiveBiasLng = reverseGeocode ? lng : locationBias?.lng;
    const hasBias = isFiniteCoord(effectiveBiasLat) && isFiniteCoord(effectiveBiasLng);
    const fallbackBias = serviceAreaBias
      ? { lat: serviceAreaBias.centerLat, lng: serviceAreaBias.centerLng }
      : undefined;
    const biasLat = hasBias ? effectiveBiasLat! : fallbackBias?.lat;
    const biasLng = hasBias ? effectiveBiasLng! : fallbackBias?.lng;

    let country = (countryCode || "").toLowerCase().trim();
    if (!country && serviceAreaBias?.country) {
      country = serviceAreaBias.country.toLowerCase().trim();
    }
    if (!country && sb) {
      try {
        const { data: saRows } = await sb
          .from("service_areas")
          .select("center_lat, center_lng, country")
          .eq("is_active", true);

        if (saRows && saRows.length > 0) {
          // If we have a location bias, check if the user is close to any active service area
          let isCloseToAny = false;
          if (hasBias) {
            for (const row of saRows) {
              const saLat = Number(row.center_lat);
              const saLng = Number(row.center_lng);
              if (Number.isFinite(saLat) && Number.isFinite(saLng)) {
                const dist = distanceMeters(biasLat, biasLng, saLat, saLng);
                if (dist < 500_000) { // Under 500 km
                  isCloseToAny = true;
                  break;
                }
              }
            }
          } else {
            // No bias coordinates, do not arbitrarily constrain the country
            isCloseToAny = false;
          }

          if (isCloseToAny) {
            const uniqueCountries = [
              ...new Set(
                saRows
                  .map((s: { country?: string | null }) => String(s.country ?? "").trim().toLowerCase())
                  .filter(Boolean)
              )
            ];
            if (uniqueCountries.length > 0) {
              country = uniqueCountries.join(",");
            }
          }
        }
      } catch (e) {
        console.warn("[place-lookup] failed to query service_areas countries:", e);
      }
    }

    if (!country && hasBias) {
      try {
        const reverseRes = await fetch(`https://api.mapbox.com/search/geocode/v6/reverse?longitude=${biasLng}&latitude=${biasLat}&access_token=${token}&limit=1`);
        if (reverseRes.ok) {
          const reverseData = await reverseRes.json();
          const contextObj = reverseData?.features?.[0]?.properties?.context;
          if (contextObj?.country?.country_code) {
            country = contextObj.country.country_code.toLowerCase();
            console.info(`[place-lookup] inferred country '${country}' via fallback reverse geocode at ${biasLat},${biasLng}`);
          }
        }
      } catch (e) {
        console.warn("[place-lookup] fallback reverse geocode for country failed:", e);
      }
    }

    // Do not force "gb" if country is not resolved. Allow global search.
    const suggestBbox = serviceAreaBias?.bbox ?? null;
    const postcodeQuery = address ? isPostcodeLikeQuery(address) : false;
    const allowedTypes = new Set(["address", "poi", "postcode", "place", "street", "locality"]);
    const defaultAutocompleteTypes = postcodeQuery
      ? ["poi", "address", "street"]
      : ["address", "poi", "street", "place", "locality"];
    const safeTypes = (Array.isArray(resultTypes) && resultTypes.length > 0
      ? resultTypes
      : defaultAutocompleteTypes)
      .map((t) => String(t).toLowerCase())
      .filter((t) => allowedTypes.has(t) && t !== "postcode");
    const searchboxTypes = safeTypes.length > 0 ? safeTypes.join(",") : defaultAutocompleteTypes.join(",");
    const geocodeTypes = safeTypes.filter((t) => t !== "poi");
    const geocodeTypesCsv = geocodeTypes.length > 0 ? geocodeTypes.join(",") : "address,street,place,locality";

    console.log("[place-lookup] request:", {
      placeId,
      address: address?.substring(0, 50),
      autocomplete,
      hasBias,
      hasServiceAreaBias: !!serviceAreaBias,
      serviceAreaId: serviceAreaId ?? null,
      biasLat,
      biasLng,
      suggestBbox: suggestBbox ?? null,
      country,
      reverseGeocode,
    });

    // ---------- Reverse geocode ----------
    if (reverseGeocode && isFiniteCoord(lat) && isFiniteCoord(lng)) {
      const [nearbyPlaces, categoryPlaces, v6Snapshot] = await Promise.all([
        fetchNearbyBookablePlaces(lat, lng, token, session, country),
        fetchNearbyCategoryPois(lat, lng, token, country),
        fetchV6ReverseSnapshot(lat, lng, token, country),
      ]);
      const pinnedPoi = choosePinnedPoi(
        nearbyPlaces,
        categoryPlaces,
        v6Snapshot
          ? {
              name: v6Snapshot.name,
              formattedAddress: v6Snapshot.formattedAddress,
              featureType: v6Snapshot.featureType,
              street: v6Snapshot.addressComponents?.street,
            }
          : null,
      );
      if (pinnedPoi) {
        const enrichedAddress = enrichPinnedPoiAddress(pinnedPoi, v6Snapshot);
        console.log("[place-lookup] reverse poi selected:", {
          name: pinnedPoi.name,
          distanceMeters: pinnedPoi.distanceMeters ?? null,
          featureType: pinnedPoi.featureType ?? null,
          category: pinnedPoi.category ?? null,
        });
        return jsonResponse({
          success: true,
          lat,
          lng,
          formattedAddress: buildPinnedPoiFormattedAddress(pinnedPoi.name, enrichedAddress),
          address: enrichedAddress || pinnedPoi.name,
          name: pinnedPoi.name,
          placeId: pinnedPoi.placeId,
          featureType: pinnedPoi.featureType || "poi",
          countryCode: v6Snapshot?.countryCode,
        });
      }

      if (v6Snapshot) {
        const normalized = normalizeV6StreetAddress({
          name: v6Snapshot.name,
          formattedAddress: v6Snapshot.formattedAddress,
          featureType: v6Snapshot.featureType,
          street: v6Snapshot.addressComponents?.street,
        });
        return jsonResponse({
          success: true,
          lat,
          lng,
          formattedAddress: normalized.formattedAddress,
          address: normalized.formattedAddress,
          name: normalized.name,
          placeId: `${lat},${lng}`,
          featureType: normalized.featureType,
          addressComponents: v6Snapshot.addressComponents,
          countryCode: v6Snapshot.countryCode,
        });
      }

      const params = new URLSearchParams({
        longitude: String(lng),
        latitude: String(lat),
        access_token: token,
        limit: "1",
      });
      if (country) params.set("country", country);

      const r = await fetch(`https://api.mapbox.com/search/geocode/v6/reverse?${params}`);
      const data = await r.json();

      if (!r.ok) {
        console.error("[place-lookup] reverse failed:", r.status, data);
        return jsonResponse(
          { success: false, error: data?.message || "Reverse geocoding failed", errorCode: "UPSTREAM" },
          502,
        );
      }

      const f = data.features?.[0];
      if (!f) {
        return jsonResponse({
          success: false,
          error: "No address found for these coordinates",
          errorCode: "ZERO_RESULTS",
        });
      }

      const [flng, flat] = f.geometry.coordinates;
      const p = f.properties || {};
      const rawName = p.name || (p.full_address || "").split(",")[0] || "Current Location";
      const name = deduplicateRepeatedStreetSuffix(rawName);
      const addressComponents = mapMapboxContextToComponents(
        p.context as Record<string, { name?: string }> | undefined,
      );
      const formattedAddress = deduplicateFormattedAddress(
        p.full_address || p.place_formatted || name,
      );
      return jsonResponse({
        success: true,
        lat: flat,
        lng: flng,
        formattedAddress,
        address: p.place_formatted || formattedAddress || name,
        name,
        placeId: p.mapbox_id || `${flat},${flng}`,
        featureType: p.feature_type,
        addressComponents,
      });
    }

    // ---------- Resolve placeId via Mapbox Search Box retrieve ----------
    if (placeId) {
      const params = new URLSearchParams({
        access_token: token,
        session_token: session,
      });
      const r = await fetch(
        `https://api.mapbox.com/search/searchbox/v1/retrieve/${encodeURIComponent(placeId)}?${params}`,
      );
      const data = await r.json();

      if (r.ok && data.features?.[0]) {
        const f = data.features[0];
        const [flng, flat] = f.geometry.coordinates;
        const p = f.properties || {};
        return jsonResponse({
          success: true,
          lat: flat,
          lng: flng,
          formattedAddress: p.full_address || p.place_formatted || p.name,
          name: p.name_preferred || p.name,
          placeId: p.mapbox_id || placeId,
        });
      }

      // If Search Box doesn't recognize the id, fall through to address geocoding (if address provided)
      console.log("[place-lookup] retrieve had no match for id:", placeId);
    }

    // ---------- Autocomplete ----------
    if (address && autocomplete) {
      const normalizedAddress = postcodeQuery ? normalizeUkPostcodeForGeocode(address) : address.trim();
      // 1) Postcode centre (also sets proximity for downstream calls)
      let postcodeCenter: { lat: number; lng: number } | null = null;
      if (postcodeQuery) {
        postcodeCenter = await geocodePostcodeCenter(
          normalizedAddress,
          token,
          country,
          biasLat,
          biasLng,
        );
      }
      const proximityLng = postcodeCenter?.lng ?? biasLng;
      const proximityLat = postcodeCenter?.lat ?? biasLat;

      logAddressSearch("ADDRESS_QUERY", {
        query: address.substring(0, 80),
        hasLocationBias: hasBias,
        serviceAreaId: serviceAreaId ?? null,
      });
      logAddressSearch("ADDRESS_QUERY_LOCATION", {
        lat: proximityLat,
        lng: proximityLng,
        source: hasBias ? "client_bias" : serviceAreaBias ? "service_area_center" : "london_fallback",
      });
      if (serviceAreaId || serviceAreaBias) {
        logAddressSearch("ADDRESS_QUERY_SERVICE_AREA", {
          serviceAreaId: serviceAreaId ?? null,
          bbox: suggestBbox,
          name: serviceAreaBias?.name ?? null,
        });
      }

      // Generic POI queries ("hospital", "station") must stay near the rider.
      // Prefer the service-area bbox; otherwise synthesize one around a real
      // proximity (not the London fallback) so far-away cities are excluded.
      const genericPoiQuery = isGenericPoiQuery(address);
      const hasRealProximity = hasBias || !!serviceAreaBias || !!postcodeCenter;
      const effectiveBbox =
        suggestBbox ??
        (postcodeQuery && hasRealProximity
          ? bboxAroundPoint(proximityLat, proximityLng, POSTCODE_SEARCH_BBOX_RADIUS_KM)
          : genericPoiQuery && hasRealProximity
          ? bboxAroundPoint(proximityLat, proximityLng, GENERIC_POI_BBOX_RADIUS_KM)
          : null);
      if (effectiveBbox && effectiveBbox !== suggestBbox) {
        logAddressSearch("ADDRESS_QUERY_GENERIC_POI_BBOX", {
          query: address.substring(0, 80),
          bbox: effectiveBbox,
          radiusKm: GENERIC_POI_BBOX_RADIUS_KM,
        });
      }

      // 2) ONECAB custom places + Mapbox suggest in parallel (was sequential — added ~200–400ms latency)
      const suggestParams = new URLSearchParams({
        q: postcodeQuery ? normalizedAddress : address,
        access_token: token,
        session_token: session,
        limit: "10",
        language: "en",
        types: searchboxTypes,
      });
      if (proximityLng != null && proximityLat != null) {
        suggestParams.set("proximity", `${proximityLng},${proximityLat}`);
        suggestParams.set("origin", `${proximityLng},${proximityLat}`);
      }
      if (country) suggestParams.set("country", country);
      if (effectiveBbox) suggestParams.set("bbox", effectiveBbox);

      const onecabPromise = (async (): Promise<PlaceSuggestion[]> => {
        try {
          if (!sb) return [];
          const { data: rows, error: rpcErr } = await sb.rpc("search_places", {
            q: address,
            p_service_area_id: serviceAreaId ?? null,
            p_limit: 5,
          });
          if (rpcErr) {
            console.warn("[place-lookup] search_places rpc error:", rpcErr.message);
            return [];
          }
          if (!Array.isArray(rows)) return [];
          return rows.map((r: {
            id: string;
            name: string;
            display_name: string | null;
            address: string;
            postcode: string | null;
            latitude: number;
            longitude: number;
            category: string | null;
            icon: string | null;
          }) => ({
            placeId: `onecab:${r.id}`,
            name: r.display_name || r.name,
            address: r.address + (r.postcode ? `, ${r.postcode}` : ""),
            lat: r.latitude,
            lng: r.longitude,
            distanceMeters:
              isFiniteCoord(proximityLat) && isFiniteCoord(proximityLng)
                ? distanceMeters(proximityLat, proximityLng, r.latitude, r.longitude)
                : undefined,
            source: "onecab_place" as const,
            category: r.category ?? undefined,
            icon: r.icon ?? undefined,
            badge: "ONECAB",
          }));
        } catch (e) {
          console.warn("[place-lookup] onecab places lookup threw:", e instanceof Error ? e.message : e);
          return [];
        }
      })();

      const suggestPromise = fetch(`https://api.mapbox.com/search/searchbox/v1/suggest?${suggestParams}`).then(
        async (r) => {
          const data = await r.json();
          return { ok: r.ok, data };
        },
      );

      // Geocoding v6 is worldwide (including Somalia) while Search Box is not.
      // Run it in parallel and treat the service-area bbox as a soft preference
      // so destinations outside the pickup area can still be found.
      const worldwidePromise = (async (): Promise<PlaceSuggestion[]> => {
        const bounded = await fetchForwardGeocodeSuggestions(
          postcodeQuery ? normalizedAddress : address,
          proximityLng,
          proximityLat,
          token,
          country,
          effectiveBbox,
          geocodeTypesCsv,
          8,
        );
        if (bounded.length > 0 || !effectiveBbox) return bounded;
        return fetchForwardGeocodeSuggestions(
          postcodeQuery ? normalizedAddress : address,
          proximityLng,
          proximityLat,
          token,
          country,
          null,
          geocodeTypesCsv,
          8,
        );
      })();

      const [onecabSuggestions, suggestResponse, worldwideSuggestions] = await Promise.all([
        onecabPromise,
        suggestPromise,
        worldwidePromise,
      ]);
      const { ok: suggestOk, data: suggestData } = suggestResponse;

      if (!suggestOk) {
        console.error("[place-lookup] suggest failed:", suggestData);
        const fallbackSuggestions = [...onecabSuggestions, ...worldwideSuggestions];
        if (fallbackSuggestions.length > 0) {
          return jsonResponse({
            success: true,
            suggestions: filterPlaceSuggestions(fallbackSuggestions, {
              isPostcodeQuery: postcodeQuery,
              maxResults: 8,
              query: postcodeQuery ? normalizedAddress : undefined,
            }),
          });
        }
        return jsonResponse(
          { success: false, error: suggestData?.message || "Autocomplete failed", errorCode: "UPSTREAM" },
          502,
        );
      }

      const mapboxSuggestions: PlaceSuggestion[] = (suggestData.suggestions ?? [])
        .map((f: {
        mapbox_id: string;
        name: string;
        name_preferred?: string;
        place_formatted?: string;
        full_address?: string;
        feature_type?: string;
        address?: string;
        distance?: number;
      }) => {
        const row = mapMapboxSuggestToRow(f);
        return {
          placeId: row.placeId,
          name: row.name,
          address: row.address,
          lat: 0,
          lng: 0,
          featureType: row.featureType,
          distanceMeters: row.distanceMeters,
          source: "mapbox" as const,
        };
      })
        .filter((row: PlaceSuggestion) => {
          if (!postcodeQuery) return true;
          return !suggestionLooksLikeForeignPostcode(row.name, row.address, normalizedAddress);
        });

      let nearbySuggestions: PlaceSuggestion[] = [];
      if (postcodeQuery && postcodeCenter) {
        const [nearbyPlaces, categoryPlaces] = await Promise.all([
          fetchNearbyBookablePlaces(
            postcodeCenter.lat,
            postcodeCenter.lng,
            token,
            session,
            country,
          ),
          fetchNearbyCategoryPois(postcodeCenter.lat, postcodeCenter.lng, token, country),
        ]);
        nearbySuggestions = [...nearbyPlaces, ...categoryPlaces];
      }

      const needsMoreResults =
        onecabSuggestions.length + worldwideSuggestions.length + mapboxSuggestions.length + nearbySuggestions.length < 8;
      let forwardPoiSuggestions: PlaceSuggestion[] = [];
      let forwardStreetSuggestions: PlaceSuggestion[] = [];
      if (!postcodeQuery && (needsMoreResults || genericPoiQuery)) {
        [forwardPoiSuggestions, forwardStreetSuggestions] = await Promise.all([
          genericPoiQuery
            ? fetchForwardPoiSuggestions(address, proximityLng, proximityLat, token, country, effectiveBbox)
            : Promise.resolve([] as PlaceSuggestion[]),
          needsMoreResults && isStreetLikeQuery(address)
            ? fetchForwardStreetSuggestions(address, proximityLng, proximityLat, token, country, effectiveBbox)
            : Promise.resolve([] as PlaceSuggestion[]),
        ]);
      } else if (postcodeQuery && postcodeCenter && needsMoreResults) {
        forwardPoiSuggestions = await fetchForwardGeocodeSuggestions(
          normalizedAddress,
          proximityLng,
          proximityLat,
          token,
          country,
          effectiveBbox,
          "poi,address",
          8,
        );
      }

      const merged = filterPlaceSuggestions(
        [
          ...onecabSuggestions,
          ...nearbySuggestions,
          ...worldwideSuggestions,
          ...forwardStreetSuggestions,
          ...forwardPoiSuggestions,
          ...mapboxSuggestions,
        ],
        {
          isPostcodeQuery: postcodeQuery,
          maxResults: 8,
          query: postcodeQuery ? normalizedAddress : undefined,
        },
      );

      merged.forEach((row, index) => {
        logAddressSearch("ADDRESS_RESULT_RANK", {
          rank: index + 1,
          name: row.name,
          source: row.source ?? "mapbox",
          distanceMeters: row.distanceMeters ?? null,
          city: row.address.split(",").slice(-2, -1)[0]?.trim() ?? null,
        });
      });

      return jsonResponse({ success: true, suggestions: merged });
    }

    // ---------- Forward geocode ----------
    if (address) {
      // UK postcodes resolve only with types=postcode — address/street returns zero results.
      if (postcodeQuery) {
        const center = await geocodePostcodeCenter(address, token, country, biasLat, biasLng);
        if (center) {
          const label = normalizeUkPostcodeForGeocode(address);
          console.log("[place-lookup] forward postcode resolved:", { address: label, ...center });
          return jsonResponse({
            success: true,
            lat: center.lat,
            lng: center.lng,
            formattedAddress: label,
            name: label,
            placeId: `mapbox_postcode:${center.lat}:${center.lng}:${encodeURIComponent(label)}`,
          });
        }
        console.log("[place-lookup] forward postcode empty:", { address: address.substring(0, 50) });
      }

      const resolved = await resolveForwardGeocode(
        address,
        token,
        country,
        biasLat,
        biasLng,
        suggestBbox,
        geocodeTypesCsv,
      );
      if (!resolved) {
        return jsonResponse({
          success: false,
          error: "No results found for this address",
          errorCode: "ZERO_RESULTS",
        });
      }

      return jsonResponse({
        success: true,
        lat: resolved.lat,
        lng: resolved.lng,
        formattedAddress: resolved.formattedAddress,
        name: resolved.name,
        placeId: resolved.placeId,
      });
    }

    return jsonResponse(
      {
        success: false,
        error: "Must provide placeId, address, or lat/lng with reverseGeocode",
        errorCode: "INVALID_REQUEST",
      },
      400,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[place-lookup] error:", message);
    return jsonResponse(
      { success: false, error: message, errorCode: "INTERNAL_ERROR" },
      500,
    );
  }
});
