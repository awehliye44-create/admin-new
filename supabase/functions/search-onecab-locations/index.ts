/**
 * ONECAB location search (SSOT) — international, proximity-restricted, cost-optimised.
 *
 * Cost controls (in order — each step can end the request without calling Google):
 *   1. Minimum query length (rollout config).
 *   2. Verified ONECAB landmarks first — exact match short-circuits Google entirely.
 *   3. Shared 14-day result cache keyed by service area + query + language + rounded centre.
 *   4. Places Autocomplete (New) with locationBias + origin (pickup/GPS).
 *      Text Search is fallback when Autocomplete is empty (postcodes / full names).
 *      Never locationRestriction. Serviceability is post-select.
 *
 * Country / language / bias radius are derived from the active service area
 * as ranking hints — nothing is hardcoded to one market.
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
const PLACES_AUTOCOMPLETE = "https://places.googleapis.com/v1/places:autocomplete";
const PLACES_DETAILS = "https://places.googleapis.com/v1/places";

/** Bias circle only — Google Places (New) circle max is 50 km. */
const MIN_RADIUS_M = 5_000;
const MAX_RADIUS_M = 50_000;
const SEARCH_UNAVAILABLE =
  "Place search is temporarily unavailable. Please try again.";

/** Compact postal codes (UK/CA/etc.) — supplemental retry, never a reject gate. */
function supplementalCompactQuery(query: string): string | null {
  const compact = query.replace(/\s+/g, "");
  if (compact.length < 5 || compact.length > 10) return null;
  if (!/^[A-Za-z0-9]+$/.test(compact)) return null;
  if (/\s/.test(query.trim())) return null;
  const spaced = `${compact.slice(0, -3)} ${compact.slice(-3)}`;
  return spaced.toLowerCase() === query.trim().toLowerCase() ? null : spaced;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function googleKey(): string | null {
  return Deno.env.get("GOOGLE_API_KEY") || Deno.env.get("GOOGLE_MAPS_API_KEY") || null;
}

function normaliseQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
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
    const userLat = Number.isFinite(Number(body?.user_latitude ?? body?.lat ?? body?.latitude))
      ? Number(body?.user_latitude ?? body?.lat ?? body?.latitude)
      : null;
    const userLng = Number.isFinite(Number(body?.user_longitude ?? body?.lng ?? body?.longitude))
      ? Number(body?.user_longitude ?? body?.lng ?? body?.longitude)
      : null;
    const sessionToken = typeof body?.session_token === "string" && body.session_token.trim()
      ? body.session_token.trim()
      : undefined;

    // ---- Rollout config ----------------------------------------------------
    const { data: rollout } = await supabase
      .from("location_search_rollout")
      .select("global_enabled, google_places_enabled, enabled_service_area_ids, min_query_length, max_results")
      .eq("id", true)
      .maybeSingle();

    const minLength = LOCATION_SEARCH_MIN_QUERY_LENGTH;
    const limit = Math.min(
      Number(body?.limit) || rollout?.max_results || LOCATION_SEARCH_MAX_RESULTS,
      LOCATION_SEARCH_MAX_RESULTS,
    );
    const query = rawQuery.trim();
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
    // Pickup / device coords are the primary bias. SA centre is fallback only.
    const searchLat = userLat ?? centreLat;
    const searchLng = userLng ?? centreLng;

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
    const cacheKey = [
      "ac-origin-v3",
      serviceAreaId,
      normaliseQuery(query),
      language,
      searchLat.toFixed(3),
      searchLng.toFixed(3),
      String(radius),
    ].join("|");

    const { data: cached } = await supabase
      .from("location_search_cache")
      .select("id, results, expires_at, hit_count")
      .eq("cache_key", cacheKey)
      .maybeSingle();

    if (cached && new Date(cached.expires_at).getTime() > Date.now()) {
      await supabase
        .from("location_search_cache")
        .update({ hit_count: (cached.hit_count ?? 0) + 1, last_used_at: new Date().toISOString() })
        .eq("id", cached.id);
      const merged = [...landmarks, ...((cached.results ?? []) as OnecabLocationResult[])];
      return json({
        success: true,
        country_code: countryCode,
        service_area_id: serviceAreaId,
        results: rankLocationSearchResults(merged, query).slice(0, limit),
        source: "cache",
      });
    }

    // ---- 3. Google Places (New) Text Search — one billable call ------------
    const key = googleKey();
    if (!key) {
      return json({
        success: true,
        results: rankLocationSearchResults(landmarks, query).slice(0, limit),
        source: "landmarks_only_no_key",
      });
    }

    const toRow = (args: {
      id: string;
      name: string;
      address: string;
      lat: number;
      lng: number;
      category?: string | null;
      distanceMetres?: number | null;
    }): OnecabLocationResult => {
      const distance = args.distanceMetres
        ?? haversineMetres(searchLat, searchLng, args.lat, args.lng);
      return {
        id: args.id,
        source: "GOOGLE_PLACES",
        provider_place_id: args.id,
        display_name: args.name || args.address,
        short_name: args.name || args.address,
        address_text: args.address || args.name,
        latitude: args.lat,
        longitude: args.lng,
        category: args.category ?? null,
        country_code: countryCode,
        region_id: sa.region_id ?? null,
        service_area_id: serviceAreaId,
        inside_service_area: isInsideOrNearServiceArea({
          lat: args.lat,
          lng: args.lng,
          centreLat,
          centreLng,
          bbox,
        }).inside,
        distance_from_search_centre_metres: distance,
        is_verified_local_landmark: false,
      };
    };

    const locationBias = {
      circle: {
        center: { latitude: searchLat, longitude: searchLng },
        radius,
      },
    };
    const origin = { latitude: searchLat, longitude: searchLng };

    const fetchPlaceDetails = async (placeId: string) => {
      const url = new URL(`${PLACES_DETAILS}/${encodeURIComponent(placeId)}`);
      url.searchParams.set("languageCode", language);
      if (sessionToken) url.searchParams.set("sessionToken", sessionToken);
      const res = await fetch(url.toString(), {
        headers: {
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask":
            "id,displayName,formattedAddress,location,primaryType",
        },
      });
      if (!res.ok) return null;
      return await res.json();
    };

    const mapTextSearchPlaces = (data: { places?: Record<string, any>[] }) => {
      const rows: OnecabLocationResult[] = [];
      for (const p of data?.places ?? []) {
        const lat = Number(p?.location?.latitude);
        const lng = Number(p?.location?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const name = String(p?.displayName?.text ?? "").trim();
        const address = String(p?.formattedAddress ?? "").trim();
        if (!name && !address) continue;
        rows.push(toRow({
          id: String(p?.id ?? `${lat},${lng}`),
          name,
          address,
          lat,
          lng,
          category: p?.primaryType ? String(p.primaryType) : null,
        }));
      }
      return rows;
    };

    const callAutocomplete = async (input: string) => {
      const body: Record<string, unknown> = {
        input,
        languageCode: language,
        origin,
        locationBias,
      };
      if (sessionToken) body.sessionToken = sessionToken;
      if (countryCode) body.regionCode = countryCode;
      return await fetch(PLACES_AUTOCOMPLETE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask":
            "suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.text,suggestions.placePrediction.distanceMeters,suggestions.placePrediction.types",
        },
        body: JSON.stringify(body),
      });
    };

    const callTextSearch = async (textQuery: string) => {
      const placesBody: Record<string, unknown> = {
        textQuery,
        languageCode: language,
        maxResultCount: limit,
        locationBias,
      };
      if (countryCode) placesBody.regionCode = countryCode;
      return await fetch(PLACES_TEXT_SEARCH, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask":
            "places.id,places.displayName,places.formattedAddress,places.location,places.primaryType",
        },
        body: JSON.stringify(placesBody),
      });
    };

    const hydrateAutocomplete = async (data: {
      suggestions?: Array<{ placePrediction?: Record<string, any> }>;
    }) => {
      const predictions = (data.suggestions ?? [])
        .map((s) => s.placePrediction)
        .filter((p): p is Record<string, any> => Boolean(p?.placeId))
        .slice(0, limit);

      const detailed = await Promise.all(predictions.map(async (prediction) => {
        const placeId = String(prediction.placeId).replace(/^places\//, '');
        const details = await fetchPlaceDetails(placeId);
        const lat = Number(details?.location?.latitude);
        const lng = Number(details?.location?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        const main = String(prediction?.structuredFormat?.mainText?.text ?? "").trim();
        const secondary = String(prediction?.structuredFormat?.secondaryText?.text ?? "").trim();
        const name = String(details?.displayName?.text ?? "").trim() || main;
        const address = String(details?.formattedAddress ?? "").trim() || secondary;
        const distanceFromOrigin = Number.isFinite(Number(prediction?.distanceMeters))
          ? Number(prediction.distanceMeters)
          : null;
        return toRow({
          id: placeId,
          name,
          address,
          lat,
          lng,
          category: details?.primaryType ? String(details.primaryType) : null,
          distanceMetres: distanceFromOrigin,
        });
      }));

      return detailed.filter((row): row is OnecabLocationResult => row != null);
    };

    let googleResults: OnecabLocationResult[] = [];
    let providerErrorStatus: number | null = null;

    const acRes = await callAutocomplete(query);
    if (acRes.ok) {
      googleResults = await hydrateAutocomplete(await acRes.json());
    } else {
      providerErrorStatus = acRes.status;
      console.error(
        `[search-onecab-locations] Autocomplete HTTP ${acRes.status}: ${await acRes.text()}`,
      );
    }

    if (googleResults.length === 0) {
      let textRes = await callTextSearch(query);
      if (!textRes.ok) {
        providerErrorStatus = textRes.status;
        console.error(
          `[search-onecab-locations] Text Search HTTP ${textRes.status}: ${await textRes.text()}`,
        );
      } else {
        googleResults = mapTextSearchPlaces(await textRes.json());
      }
      const compactRetry = supplementalCompactQuery(query);
      if (googleResults.length === 0 && compactRetry) {
        textRes = await callTextSearch(compactRetry);
        if (textRes.ok) {
          googleResults = mapTextSearchPlaces(await textRes.json());
        }
      }
    }

    if (googleResults.length === 0 && providerErrorStatus && landmarks.length === 0) {
      return json({
        success: false,
        message: SEARCH_UNAVAILABLE,
        provider_status: providerErrorStatus,
      }, 502);
    }

    // ---- 4. Persist cache (best effort) — never cache an empty Google miss
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
      country_code: countryCode,
      service_area_id: serviceAreaId,
      results: [...rankLocationSearchResults(landmarks, query), ...googleResults].slice(0, limit),
      source: googleResults.length > 0 ? "google_places" : "landmarks_only",
    });
  } catch (err) {
    console.error("[search-onecab-locations] error", err);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
