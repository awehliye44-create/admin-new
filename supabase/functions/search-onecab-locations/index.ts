/**
 * ONECAB location search (SSOT) — international, proximity-restricted, cost-optimised.
 *
 * Cost controls (in order — each step can end the request without calling Google):
 *   1. Minimum query length (rollout config).
 *   2. Verified ONECAB landmarks first — exact match short-circuits Google entirely.
 *   3. Shared 14-day result cache keyed by service area + query + language + rounded centre.
 *   4. A single Places API (New) Text Search call with a HARD locationRestriction circle,
 *      so suggestions can never jump to another city/country.
 *
 * Country / language / radius are all derived dynamically from the service area
 * (and its region) — nothing is hardcoded to any market.
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import {
  geoBoundaryToBbox,
  haversineMetres,
  hasStrongExactLandmarkMatch,
  isInsideOrNearServiceArea,
  LOCATION_SEARCH_MAX_RESULTS,
  LOCATION_SEARCH_MIN_QUERY_LENGTH,
  normalizeCountryCode,
  type OnecabLocationResult,
  rankLocationSearchResults,
} from "../_shared/onecabLocationSearchSSOT.ts";

const PLACES_TEXT_SEARCH = "https://places.googleapis.com/v1/places:searchText";

/** Hard proximity bounds (metres) — never suggest beyond the upper bound. */
const MIN_RADIUS_M = 5_000;
const MAX_RADIUS_M = 60_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function googleKeyCandidates(): string[] {
  const ordered = [
    Deno.env.get("GOOGLE_PLACES_API_KEY"),
    Deno.env.get("GOOGLE_API_KEY"),
    Deno.env.get("GOOGLE_MAPS_API_KEY"),
    Deno.env.get("GOOGLE_MAPS_SERVER_KEY"),
    Deno.env.get("GOOGLE_MAPS_DIRECTIONS_SERVER_KEY"),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ordered) {
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function isRetryableGoogleKeyFailure(status: number, body: string): boolean {
  if (status === 403 || status === 400) {
    return (
      body.includes("API_KEY_INVALID") ||
      body.includes("API key expired") ||
      body.includes("API_KEY_SERVICE_BLOCKED") ||
      body.includes("PERMISSION_DENIED") ||
      body.includes("REQUEST_DENIED")
    );
  }
  return false;
}

function isRetryableAutocompleteStatus(status: string): boolean {
  return (
    status === "REQUEST_DENIED" ||
    status === "INVALID_REQUEST" ||
    status === "OVER_QUERY_LIMIT" ||
    status === "UNKNOWN_ERROR"
  );
}

function normaliseQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Normalise rider input for address / UK postcode search.
 * "mk91" → "MK9 1", "mk91aa" → "MK9 1AA" so Autocomplete can match streets & premises.
 */
function normalizeSearchQuery(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  const pc = trimmed.match(/^([A-Za-z]{1,2}\d{1,2})\s*(\d[A-Za-z]{0,2})$/);
  if (pc) return `${pc[1]!.toUpperCase()} ${pc[2]!.toUpperCase()}`;
  return trimmed;
}

function looksLikeStreetOrAddress(q: string): boolean {
  if (/\d/.test(q) && /[A-Za-z]{3,}/.test(q)) return true;
  if (
    /\b(road|rd|street|st|avenue|ave|lane|ln|drive|dr|close|court|way|place|crescent|boulevard|blvd|gate|walk|row|terrace)\b/i
      .test(q)
  ) {
    return true;
  }
  if (/^[A-Za-z]{1,2}\d/i.test(q)) return true;
  return false;
}

/** UK outward / full postcode shape — prefer geocode results over business POIs. */
function isPostcodeQuery(q: string): boolean {
  return /^[A-Za-z]{1,2}\d{1,2}(\s*\d[A-Za-z]{0,2})?$/i.test(q.trim());
}

/** House number + street — prefer precise addresses. */
function isHouseAddressQuery(q: string): boolean {
  return /^\d+[A-Za-z]?\s+[A-Za-z]/i.test(q.trim());
}

type AutocompletePrediction = {
  place_id: string;
  description: string;
  main_text: string;
};

/** Places Autocomplete — returns streets, house numbers, postcodes, and businesses. */
async function googleAutocomplete(args: {
  apiKey: string;
  query: string;
  countryCode: string | null;
  centreLat: number;
  centreLng: number;
  radius: number;
  language: string;
  types?: string | null;
  signal: AbortSignal;
}): Promise<AutocompletePrediction[]> {
  const params = new URLSearchParams({
    input: args.query,
    key: args.apiKey,
    language: args.language || "en",
    location: `${args.centreLat},${args.centreLng}`,
    radius: String(Math.round(args.radius)),
  });
  // Optional types: geocode/address for streets & postcodes; omit for mixed POI+address.
  if (args.types) params.set("types", args.types);
  if (args.countryCode) {
    params.set("components", `country:${args.countryCode.toLowerCase()}`);
  }
  const res = await fetch(
    `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`,
    { signal: args.signal },
  );
  if (!res.ok) throw new Error(`GOOGLE_AUTOCOMPLETE_HTTP_${res.status}`);
  const json = await res.json() as {
    status?: string;
    predictions?: Array<{
      place_id?: string;
      description?: string;
      structured_formatting?: { main_text?: string };
    }>;
  };
  const status = String(json.status ?? "UNKNOWN");
  if (status !== "OK" && status !== "ZERO_RESULTS") {
    throw new Error(`GOOGLE_AUTOCOMPLETE_${status}`);
  }
  return (json.predictions ?? [])
    .map((p) => ({
      place_id: String(p.place_id ?? ""),
      description: String(p.description ?? ""),
      main_text: String(p.structured_formatting?.main_text ?? p.description ?? ""),
    }))
    .filter((p) => p.place_id);
}

async function googlePlaceDetails(args: {
  apiKey: string;
  placeId: string;
  language: string;
  signal: AbortSignal;
}): Promise<{
  lat: number;
  lng: number;
  name: string;
  address: string;
  types: string[];
} | null> {
  const params = new URLSearchParams({
    place_id: args.placeId,
    fields: "geometry,name,formatted_address,types",
    key: args.apiKey,
    language: args.language || "en",
  });
  const res = await fetch(
    `https://maps.googleapis.com/maps/api/place/details/json?${params}`,
    { signal: args.signal },
  );
  if (!res.ok) return null;
  const json = await res.json() as {
    status?: string;
    result?: {
      name?: string;
      formatted_address?: string;
      types?: string[];
      geometry?: { location?: { lat?: number; lng?: number } };
    };
  };
  if (json.status !== "OK" || !json.result?.geometry?.location) return null;
  const lat = Number(json.result.geometry.location.lat);
  const lng = Number(json.result.geometry.location.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    name: String(json.result.name ?? ""),
    address: String(json.result.formatted_address ?? json.result.name ?? ""),
    types: Array.isArray(json.result.types) ? json.result.types.map(String) : [],
  };
}

async function autocompleteWithKeyFallback(args: {
  query: string;
  countryCode: string | null;
  centreLat: number;
  centreLng: number;
  radius: number;
  language: string;
  types?: string | null;
  signal: AbortSignal;
}): Promise<{ apiKey: string; predictions: AutocompletePrediction[] }> {
  const keys = googleKeyCandidates();
  if (keys.length === 0) throw new Error("GOOGLE_PLACES_KEY_MISSING");
  let lastError: Error | null = null;
  for (const apiKey of keys) {
    try {
      const predictions = await googleAutocomplete({ ...args, apiKey });
      return { apiKey, predictions };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message;
      const status = msg.replace(/^GOOGLE_AUTOCOMPLETE_/, "");
      if (!isRetryableAutocompleteStatus(status) && !msg.startsWith("GOOGLE_AUTOCOMPLETE_HTTP_")) {
        throw lastError;
      }
      console.error("[search-onecab-locations] autocomplete key rejected", status);
    }
  }
  throw lastError ?? new Error("GOOGLE_AUTOCOMPLETE_FAILED");
}

/** Dynamic search radius from the service area polygon (fallback: 25 km). */
function radiusFromBbox(
  centreLat: number,
  centreLng: number,
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null,
): number {
  if (!bbox) return 25_000;
  const corners: [number, number][] = [
    [bbox.minLat, bbox.minLng],
    [bbox.minLat, bbox.maxLng],
    [bbox.maxLat, bbox.minLng],
    [bbox.maxLat, bbox.maxLng],
  ];
  let max = 0;
  for (const [lat, lng] of corners) {
    max = Math.max(max, haversineMetres(centreLat, centreLng, lat, lng));
  }
  // Small pad so edge-of-area addresses still resolve.
  const padded = Math.round(max * 1.15);
  return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, padded));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // ---- Auth: any signed-in ONECAB user may search ------------------------
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) return json({ success: false, error: "Unauthorized" }, 401);
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ success: false, error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "search");
    if (action !== "search") return json({ success: false, error: "Unsupported action" }, 400);

    const rawQuery = typeof body?.query === "string" ? body.query : "";
    const serviceAreaId = body?.service_area_id ? String(body.service_area_id) : null;
    const language = typeof body?.language === "string" && body.language.length >= 2
      ? body.language.slice(0, 5)
      : "en";
    const userLat = Number.isFinite(Number(body?.user_latitude ?? body?.lat))
      ? Number(body?.user_latitude ?? body?.lat)
      : null;
    const userLng = Number.isFinite(Number(body?.user_longitude ?? body?.lng))
      ? Number(body?.user_longitude ?? body?.lng)
      : null;

    // ---- Rollout config ----------------------------------------------------
    const { data: rollout } = await supabase
      .from("location_search_rollout")
      .select("global_enabled, google_places_enabled, enabled_service_area_ids, min_query_length, max_results")
      .eq("id", true)
      .maybeSingle();

    const minLength = rollout?.min_query_length ?? LOCATION_SEARCH_MIN_QUERY_LENGTH;
    const limit = Math.min(
      Number(body?.limit) || rollout?.max_results || LOCATION_SEARCH_MAX_RESULTS,
      LOCATION_SEARCH_MAX_RESULTS,
    );
    const query = normalizeSearchQuery(rawQuery);
    if (query.length < minLength) return json({ success: true, results: [], reason: "query_too_short" });
    if (!serviceAreaId) return json({ success: true, results: [], reason: "missing_service_area" });

    const ssotEnabled = rollout?.global_enabled === true
      || (rollout?.enabled_service_area_ids ?? []).includes(serviceAreaId);
    if (!ssotEnabled) return json({ success: true, results: [], reason: "rollout_disabled" });

    // ---- Service area geography (dynamic, international) -------------------
    const { data: sa } = await supabase
      .from("service_areas")
      .select("id, region_id, name, country, center_lat, center_lng, geo_boundary")
      .eq("id", serviceAreaId)
      .maybeSingle();

    if (!sa) return json({ success: true, results: [], reason: "service_area_not_found" });

    let countryCode = normalizeCountryCode(sa.country);
    if (!countryCode && sa.region_id) {
      const { data: region } = await supabase
        .from("regions")
        .select("country_code")
        .eq("id", sa.region_id)
        .maybeSingle();
      countryCode = normalizeCountryCode(region?.country_code ?? null);
    }

    const bbox = geoBoundaryToBbox(sa.geo_boundary);
    const centreLat = sa.center_lat ?? (bbox ? (bbox.minLat + bbox.maxLat) / 2 : null);
    const centreLng = sa.center_lng ?? (bbox ? (bbox.minLng + bbox.maxLng) / 2 : null);
    if (centreLat == null || centreLng == null) {
      return json({ success: true, results: [], reason: "service_area_has_no_centre" });
    }

    const radius = radiusFromBbox(centreLat, centreLng, bbox);
    // Bias to the operator's live position when it is inside the area, else the area centre.
    const useUserCentre = userLat != null && userLng != null
      && haversineMetres(centreLat, centreLng, userLat, userLng) <= radius;
    const searchLat = useUserCentre ? userLat! : centreLat;
    const searchLng = useUserCentre ? userLng! : centreLng;

    // ---- 1. Verified ONECAB landmarks (free) -------------------------------
    const like = `%${query.replace(/[%_]/g, "")}%`;
    const { data: landmarkRows } = await supabase
      .from("onecab_location_landmarks")
      .select("id, canonical_name, alternative_names, category, latitude, longitude, address_description, country_code, region_id, service_area_id, is_verified, search_priority")
      .eq("service_area_id", serviceAreaId)
      .eq("enabled", true)
      .or(`canonical_name.ilike.${like},address_description.ilike.${like}`)
      .limit(limit);

    const landmarks: OnecabLocationResult[] = (landmarkRows ?? []).map((l) => {
      const near = isInsideOrNearServiceArea({
        lat: l.latitude,
        lng: l.longitude,
        centreLat: searchLat,
        centreLng: searchLng,
        bbox,
      });
      return {
        id: l.id,
        source: "ONECAB_LANDMARK",
        provider_place_id: null,
        display_name: l.canonical_name,
        short_name: l.canonical_name,
        address_text: l.address_description ?? l.canonical_name,
        latitude: l.latitude,
        longitude: l.longitude,
        category: l.category,
        country_code: normalizeCountryCode(l.country_code),
        region_id: l.region_id,
        service_area_id: l.service_area_id,
        inside_service_area: near.inside,
        distance_from_search_centre_metres: near.distanceMetres,
        is_verified_local_landmark: Boolean(l.is_verified),
        alternative_names: (l.alternative_names ?? []) as string[],
      };
    });

    if (hasStrongExactLandmarkMatch(landmarks, query)) {
      return json({
        success: true,
        results: rankLocationSearchResults(landmarks, query).slice(0, limit),
        source: "landmarks_exact",
      });
    }

    if (rollout?.google_places_enabled === false) {
      return json({
        success: true,
        results: rankLocationSearchResults(landmarks, query).slice(0, limit),
        source: "landmarks_only",
      });
    }

    // ---- 2. Cache lookup (free) -------------------------------------------
    // v3: postcode/address-typed Autocomplete (invalidate POI-skewed v2 cache).
    const cacheKey = [
      "v3",
      serviceAreaId,
      normaliseQuery(query),
      language,
      searchLat.toFixed(2),
      searchLng.toFixed(2),
      String(radius),
    ].join("|");

    const { data: cached } = await supabase
      .from("location_search_cache")
      .select("id, results, expires_at, hit_count")
      .eq("cache_key", cacheKey)
      .maybeSingle();

    if (cached && new Date(cached.expires_at).getTime() > Date.now()) {
      const cachedResults = (cached.results ?? []) as OnecabLocationResult[];
      // Never serve a stale empty miss — re-query so streets/postcodes can recover.
      if (cachedResults.length > 0) {
        await supabase
          .from("location_search_cache")
          .update({ hit_count: (cached.hit_count ?? 0) + 1, last_used_at: new Date().toISOString() })
          .eq("id", cached.id);
        const merged = [...landmarks, ...cachedResults];
        return json({
          success: true,
          results: rankLocationSearchResults(merged, query).slice(0, limit),
          source: "cache",
        });
      }
    }

    // ---- 3. Google Places — Autocomplete first (streets / houses / postcodes) -
    const keys = googleKeyCandidates();
    if (keys.length === 0) {
      return json({
        success: true,
        results: rankLocationSearchResults(landmarks, query).slice(0, limit),
        source: "landmarks_only_no_key",
        message: "Place search is temporarily unavailable. Please try again.",
      });
    }

    const saName = typeof sa.name === "string" ? sa.name.trim() : "";
    let googleQuery = query;
    // Append locality for street names — not for postcodes (hurts MK9 1 matching).
    if (
      looksLikeStreetOrAddress(query) &&
      !isPostcodeQuery(query) &&
      saName &&
      !normaliseQuery(query).includes(normaliseQuery(saName))
    ) {
      googleQuery = `${query}, ${saName}`;
    }
    const autocompleteTypes = isPostcodeQuery(query)
      ? "geocode"
      : isHouseAddressQuery(query)
      ? "address"
      : null;

    let googleResults: OnecabLocationResult[] = [];
    let source = "google_places";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9_000);

    try {
      // Primary: Autocomplete returns roads, house numbers, postcodes — not only POIs.
      const auto = await autocompleteWithKeyFallback({
        query: googleQuery,
        countryCode,
        centreLat: searchLat,
        centreLng: searchLng,
        radius,
        language,
        types: autocompleteTypes,
        signal: controller.signal,
      });

      const top = auto.predictions.slice(0, limit);
      const detailed = await Promise.all(
        top.map(async (p) => {
          const d = await googlePlaceDetails({
            apiKey: auto.apiKey,
            placeId: p.place_id,
            language,
            signal: controller.signal,
          });
          if (!d) return null;
          const distance = haversineMetres(searchLat, searchLng, d.lat, d.lng);
          if (distance > radius) return null;
          const primaryType = d.types.find((t) =>
            !["geocode", "political", "establishment"].includes(t)
          ) ?? d.types[0] ?? null;
          const row: OnecabLocationResult = {
            id: `google:${p.place_id}`,
            source: "GOOGLE_PLACES",
            provider_place_id: p.place_id,
            display_name: d.name || p.main_text || d.address,
            short_name: p.main_text || d.name || d.address,
            address_text: d.address || p.description,
            latitude: d.lat,
            longitude: d.lng,
            category: primaryType,
            country_code: countryCode,
            region_id: sa.region_id ?? null,
            service_area_id: serviceAreaId,
            inside_service_area: isInsideOrNearServiceArea({
              lat: d.lat,
              lng: d.lng,
              centreLat,
              centreLng,
              bbox,
            }).inside,
            distance_from_search_centre_metres: distance,
            is_verified_local_landmark: false,
          };
          return row;
        }),
      );
      googleResults = detailed.filter((r): r is OnecabLocationResult => r != null);
      source = "google_autocomplete";

      // Fallback: Places Text Search (New) with soft bias when Autocomplete is empty.
      if (googleResults.length === 0) {
        const placesBody: Record<string, unknown> = {
          textQuery: googleQuery,
          languageCode: language,
          maxResultCount: limit,
          locationBias: {
            circle: {
              center: { latitude: searchLat, longitude: searchLng },
              radius,
            },
          },
        };
        if (countryCode) placesBody.regionCode = countryCode;

        let res: Response | null = null;
        let providerErrorText = "";
        let providerStatus = 0;
        for (let i = 0; i < keys.length; i += 1) {
          const key = keys[i]!;
          const attempt = await fetch(PLACES_TEXT_SEARCH, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Goog-Api-Key": key,
              "X-Goog-FieldMask":
                "places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.types",
            },
            body: JSON.stringify(placesBody),
          });
          if (attempt.ok) {
            res = attempt;
            break;
          }
          const text = await attempt.text();
          providerStatus = attempt.status;
          providerErrorText = text;
          if (!isRetryableGoogleKeyFailure(attempt.status, text) || i === keys.length - 1) {
            break;
          }
        }

        if (!res || !res.ok) {
          console.error(
            `[search-onecab-locations] Text Search fallback failed: ${providerStatus} ${providerErrorText.slice(0, 200)}`,
          );
          clearTimeout(timer);
          return json({
            success: true,
            results: rankLocationSearchResults(landmarks, query).slice(0, limit),
            source: "landmarks_only_provider_error",
            provider_status: providerStatus,
            message: "Place search is temporarily unavailable. Please try again.",
          });
        }

        const data = await res.json();
        for (const p of (data?.places ?? []) as Record<string, any>[]) {
          const lat = Number(p?.location?.latitude);
          const lng = Number(p?.location?.longitude);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
          const distance = haversineMetres(searchLat, searchLng, lat, lng);
          if (distance > radius) continue;
          const name = String(p?.displayName?.text ?? "").trim();
          const address = String(p?.formattedAddress ?? "").trim();
          if (!name && !address) continue;
          googleResults.push({
            id: String(p?.id ?? `${lat},${lng}`),
            source: "GOOGLE_PLACES",
            provider_place_id: p?.id ? String(p.id) : null,
            display_name: name || address,
            short_name: name || address,
            address_text: address || name,
            latitude: lat,
            longitude: lng,
            category: p?.primaryType ? String(p.primaryType) : null,
            country_code: countryCode,
            region_id: sa.region_id ?? null,
            service_area_id: serviceAreaId,
            inside_service_area: isInsideOrNearServiceArea({
              lat,
              lng,
              centreLat,
              centreLng,
              bbox,
            }).inside,
            distance_from_search_centre_metres: distance,
            is_verified_local_landmark: false,
          });
        }
        source = "google_text_search";
      }
    } catch (err) {
      clearTimeout(timer);
      console.error("[search-onecab-locations] google search failed", err);
      return json({
        success: true,
        results: rankLocationSearchResults(landmarks, query).slice(0, limit),
        source: "landmarks_only_provider_error",
        message: "Place search is temporarily unavailable. Please try again.",
      });
    }
    clearTimeout(timer);

    // ---- 4. Persist cache (best effort) — never cache empty provider misses --
    if (googleResults.length > 0) {
      await supabase.from("location_search_cache").upsert({
        cache_key: cacheKey,
        service_area_id: serviceAreaId,
        normalized_query: normaliseQuery(query),
        language_code: language,
        centre_lat: searchLat,
        centre_lng: searchLng,
        radius_metres: radius,
        results: googleResults,
        hit_count: 0,
        last_used_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      }, { onConflict: "cache_key" });
    }

    return json({
      success: true,
      results: rankLocationSearchResults([...landmarks, ...googleResults], query).slice(0, limit),
      source,
    });
  } catch (err) {
    console.error("[search-onecab-locations] error", err);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
