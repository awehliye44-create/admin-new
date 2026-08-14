import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { corsHeaders } from "../_shared/corsHeaders.ts";
import { distanceMeters } from "../../../shared/placeSuggestionFilter.ts";
import {
  normalizeUkPostcodeQuery,
  scoreUkPostcodeSuggestion,
  ukOutwardAreasMatch,
} from "../../../shared/ukPostcodeSearch.ts";

interface LocationBias {
  lat: number;
  lng: number;
  radiusMeters?: number;
}

interface RequestBody {
  query?: string;
  maxResults?: number;
  locationBias?: LocationBias;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const rawQuery = String(body.query || "").trim();
    const query = normalizeUkPostcodeQuery(rawQuery);
    const maxResults = Math.min(8, Math.max(1, Number(body.maxResults) || 8));

    if (query.length < 2) {
      return json({ success: false, error: "Query too short", errorCode: "INVALID_REQUEST" }, 400);
    }

    const token = Deno.env.get("MAPBOX_PUBLIC_TOKEN");
    if (!token) {
      console.error("[postcode-lookup] MAPBOX_PUBLIC_TOKEN not configured");
      return json(
        { success: false, error: "Geocoding not configured", errorCode: "KEY_MISSING" },
        500,
      );
    }

    const hasBias =
      typeof body.locationBias?.lat === "number" &&
      typeof body.locationBias?.lng === "number" &&
      Number.isFinite(body.locationBias.lat) &&
      Number.isFinite(body.locationBias.lng);
    const proximityLat = hasBias ? body.locationBias!.lat : null;
    const proximityLng = hasBias ? body.locationBias!.lng : null;

    const params = new URLSearchParams({
      q: query,
      access_token: token,
      country: "gb",
      types: "postcode",
      limit: "10",
      language: "en",
    });
    if (hasBias) {
      params.set("proximity", `${proximityLng},${proximityLat}`);
      params.set("bbox", bboxAroundPoint(proximityLat!, proximityLng!, 45));
    }

    const r = await fetch(`https://api.mapbox.com/search/geocode/v6/forward?${params}`);
    const data = await r.json();

    if (!r.ok) {
      console.error("[postcode-lookup] Mapbox:", r.status, data?.message);
      return json(
        {
          success: false,
          error: data?.message || "Geocode failed",
          errorCode: "UPSTREAM",
        },
        502,
      );
    }

    type MFeature = {
      geometry?: { coordinates?: [number, number] };
      properties?: {
        name?: string;
        name_preferred?: string;
        full_address?: string;
        place_formatted?: string;
        context?: { postcode?: { name?: string } };
      };
    };

    const features: MFeature[] = Array.isArray(data.features) ? data.features : [];
    const candidates: Array<{
      placeId: string;
      name: string;
      address: string;
      formattedAddress: string;
      postcode: string;
      lat: number;
      lng: number;
      source: "mapbox_postcode";
      distanceMeters?: number;
    }> = [];

    const seen = new Set<string>();

    for (const f of features) {
      const coords = f.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const lng = Number(coords[0]);
      const lat = Number(coords[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const p = f.properties ?? {};
      const postcodeRaw =
        p.context?.postcode?.name || p.name_preferred || p.name || null;
      const label = postcodeRaw ? normalizeUkPostcodeQuery(postcodeRaw) : query;
      if (!ukOutwardAreasMatch(query, label)) continue;

      const dedupe = `${label}|${lat.toFixed(5)},${lng.toFixed(5)}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);

      const formatted = p.full_address || p.place_formatted || label;
      const enc = encodeURIComponent(label);
      const dist = hasBias ? distanceMeters(proximityLat!, proximityLng!, lat, lng) : undefined;

      candidates.push({
        placeId: `mapbox_postcode:${lat}:${lng}:${enc}`,
        name: label,
        address: formatted,
        formattedAddress: formatted,
        postcode: label,
        lat,
        lng,
        source: "mapbox_postcode",
        distanceMeters: dist,
      });
    }

    const ranked = [...candidates].sort((a, b) => {
      const sa = scoreUkPostcodeSuggestion(a.postcode, { query, proximityLat, proximityLng }, a.distanceMeters);
      const sb = scoreUkPostcodeSuggestion(b.postcode, { query, proximityLat, proximityLng }, b.distanceMeters);
      if (sa !== sb) return sa - sb;
      return (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity);
    });

    const suggestions = ranked.slice(0, maxResults);
    return json({ success: true, suggestions });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[postcode-lookup]", message);
    return json({ success: false, error: message, errorCode: "INTERNAL_ERROR" }, 500);
  }
});
