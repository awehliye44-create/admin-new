import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { corsHeaders } from "../_shared/corsHeaders.ts";

interface RouteRequest {
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  intermediateStops?: { lat: number; lng: number }[];
  departureTime?: string; // ISO string for traffic-aware routing
}

interface RouteResponse {
  success: boolean;
  distanceMeters?: number;
  distanceKm?: number;
  durationSeconds?: number;
  durationMinutes?: number;
  polyline?: string;
  source?: "mapbox_directions" | "haversine";
  error?: string;
  errorCode?: string;
  mapboxCode?: string;
}

function calculateHaversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Only forward depart_at when Mapbox will accept it — bad values abort the whole request. */
function safeDepartAt(departureTime: string | undefined): string | null {
  if (!departureTime || typeof departureTime !== "string") return null;
  const ms = Date.parse(departureTime);
  if (!Number.isFinite(ms)) return null;
  // Mapbox rejects far-past / far-future depart_at; drop rather than fail routing.
  const now = Date.now();
  if (ms < now - 5 * 60_000 || ms > now + 7 * 24 * 60 * 60_000) return null;
  return new Date(ms).toISOString();
}

/**
 * Mapbox Directions — try driving-traffic, then plain driving.
 * Returns null when Mapbox cannot produce a route (caller may haversine).
 */
async function tryMapboxDirections(
  token: string,
  request: RouteRequest,
  profile: "driving-traffic" | "driving",
): Promise<RouteResponse | null> {
  const { originLat, originLng, destLat, destLng, intermediateStops, departureTime } = request;

  try {
    const coords: string[] = [`${originLng},${originLat}`];
    for (const s of intermediateStops || []) {
      coords.push(`${s.lng},${s.lat}`);
    }
    coords.push(`${destLng},${destLat}`);

    const params = new URLSearchParams({
      access_token: token,
      geometries: "polyline",
      overview: "full",
      steps: "false",
      annotations: "duration,distance",
      language: "en",
    });
    if (profile === "driving-traffic") {
      const departAt = safeDepartAt(departureTime);
      if (departAt) params.set("depart_at", departAt);
    }

    const url =
      `https://api.mapbox.com/directions/v5/mapbox/${profile}/` +
      `${coords.join(";")}?${params}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const data = await response.json();

    if (!response.ok || data.code !== "Ok" || !Array.isArray(data.routes) || data.routes.length === 0) {
      console.error("Mapbox Directions error:", profile, data?.code, data?.message);
      return null;
    }

    const route = data.routes[0];
    const distanceMeters = Math.round(Number(route.distance) || 0);
    const durationSeconds = Math.round(Number(route.duration) || 0);

    console.log("Mapbox Directions success:", { profile, distanceMeters, durationSeconds });

    return {
      success: true,
      distanceMeters,
      distanceKm: Math.round((distanceMeters / 1000) * 100) / 100,
      durationSeconds,
      durationMinutes: Math.ceil(durationSeconds / 60),
      polyline: typeof route.geometry === "string" ? route.geometry : undefined,
      source: "mapbox_directions",
    };
  } catch (error) {
    console.error("Mapbox Directions exception:", profile, error);
    return null;
  }
}

async function resolveMapboxRoute(
  token: string,
  body: RouteRequest,
): Promise<RouteResponse | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(250 * attempt);
    const traffic = await tryMapboxDirections(token, body, "driving-traffic");
    if (traffic) return traffic;
    const driving = await tryMapboxDirections(token, body, "driving");
    if (driving) return driving;
  }
  return null;
}

function normalizeCoordinateBody(
  raw: RouteRequest,
): { ok: false; response: RouteResponse } | { ok: true; body: RouteRequest } {
  const oLat = Number(raw.originLat);
  const oLng = Number(raw.originLng);
  const dLat = Number(raw.destLat);
  const dLng = Number(raw.destLng);
  if (![oLat, oLng, dLat, dLng].every((n) => Number.isFinite(n))) {
    return {
      ok: false,
      response: {
        success: false,
        error: "Missing or invalid coordinates",
        errorCode: "INVALID_REQUEST",
      },
    };
  }
  const stops = (raw.intermediateStops || [])
    .map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) }))
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  return {
    ok: true,
    body: {
      ...raw,
      originLat: oLat,
      originLng: oLng,
      destLat: dLat,
      destLng: dLng,
      intermediateStops: stops.length > 0 ? stops : undefined,
    },
  };
}

function getHaversineFallback(request: RouteRequest): RouteResponse {
  const { originLat, originLng, destLat, destLng, intermediateStops } = request;

  let totalDistance = 0;
  let prevLat = originLat;
  let prevLng = originLng;

  for (const stop of intermediateStops || []) {
    totalDistance += calculateHaversine(prevLat, prevLng, stop.lat, stop.lng);
    prevLat = stop.lat;
    prevLng = stop.lng;
  }

  totalDistance += calculateHaversine(prevLat, prevLng, destLat, destLng);

  const roadDistance = totalDistance * 1.3;
  const distanceMeters = Math.round(roadDistance * 1000);
  const durationMinutes = Math.max(Math.ceil((roadDistance / 30) * 60), 3);

  console.log("Using Haversine fallback:", { distanceKm: roadDistance, durationMinutes });

  return {
    success: true,
    distanceMeters,
    distanceKm: Math.round(roadDistance * 100) / 100,
    durationSeconds: durationMinutes * 60,
    durationMinutes,
    source: "haversine",
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const token = Deno.env.get("MAPBOX_PUBLIC_TOKEN");

    if (!token) {
      console.error("MAPBOX_PUBLIC_TOKEN not configured");
      const rawBody: RouteRequest = await req.json();
      const norm = normalizeCoordinateBody(rawBody);
      if (!norm.ok) {
        return new Response(JSON.stringify(norm.response), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const fallback = getHaversineFallback(norm.body);
      fallback.error = "Mapbox token not configured, using estimate";
      return new Response(
        JSON.stringify(fallback),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const rawBody: RouteRequest = await req.json();
    const norm = normalizeCoordinateBody(rawBody);
    if (!norm.ok) {
      console.warn("Route calculation invalid coordinates:", JSON.stringify(rawBody));
      return new Response(JSON.stringify(norm.response), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const body = norm.body;

    console.log("Route calculation request:", {
      originLat: body.originLat,
      originLng: body.originLng,
      destLat: body.destLat,
      destLng: body.destLng,
      stops: body.intermediateStops?.length || 0,
    });

    let result = await resolveMapboxRoute(token, body);

    if (!result) {
      console.log("Mapbox Directions failed after retries, using Haversine fallback");
      result = getHaversineFallback(body);
      result.error = "Routing API unavailable, using distance estimate";
      result.errorCode = "MAPBOX_UNAVAILABLE";
    }

    return new Response(
      JSON.stringify(result),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Route calculation error:", message);

    try {
      const rawBody: RouteRequest = await req.json();
      const norm = normalizeCoordinateBody(rawBody);
      if (!norm.ok) {
        return new Response(JSON.stringify(norm.response), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const fallback = getHaversineFallback(norm.body);
      fallback.error = message;
      fallback.errorCode = "INTERNAL_ERROR";
      return new Response(
        JSON.stringify(fallback),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch {
      return new Response(
        JSON.stringify({
          success: false,
          error: message,
          errorCode: "INTERNAL_ERROR",
        } as RouteResponse),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  }
});
