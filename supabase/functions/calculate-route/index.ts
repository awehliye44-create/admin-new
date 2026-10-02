import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { corsHeaders } from "../_shared/corsHeaders.ts";
import { requireSignedInOrService } from "../_shared/callerGate.ts";
import {
  buildRouteArtifactInsert,
  persistRouteArtifact,
  resolveServiceAreaIdForPickup,
} from "../_shared/serverFareAuthoritySSOT.ts";

interface RouteRequest {
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  intermediateStops?: { lat: number; lng: number }[];
  departureTime?: string; // ISO string for traffic-aware routing
  /** Opt-in full polyline — pricing/quote paths omit geometry for latency. */
  includeGeometry?: boolean;
}

interface RouteTimings {
  totalMs: number;
  setupMs: number;
  mapboxMs: number;
  cacheHit: boolean;
  profile: string | null;
  artifactMs?: number;
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
  timings?: RouteTimings;
  /** Opaque server route artifact (route_quote_artifacts.id) for calculate-fare. */
  routeQuoteId?: string | null;
  routeQuoteExpiresAt?: string | null;
  /** Server geofence SA for the pickup, bound into the route artifact. */
  serverServiceAreaId?: string | null;
}

type RouteArtifactContext = {
  userId: string;
  admin: SupabaseClient;
  serviceAreaP: ReturnType<typeof resolveServiceAreaIdForPickup>;
};

/**
 * Bind a Mapbox measurement to its owner, ordered route and server SA.
 * Haversine estimates are never persisted — they cannot price a booking.
 */
async function attachRouteArtifact(
  ctx: RouteArtifactContext | null,
  body: RouteRequest,
  result: RouteResponse,
  profile: string | null,
): Promise<RouteResponse> {
  if (!ctx || result.source !== "mapbox_directions") {
    return { ...result, routeQuoteId: null, routeQuoteExpiresAt: null };
  }
  const started = Date.now();
  const sa = await ctx.serviceAreaP;
  if (!sa.ok) {
    console.error("Route artifact skipped — service area lookup failed:", sa.error);
    return { ...result, routeQuoteId: null, routeQuoteExpiresAt: null };
  }
  const insert = buildRouteArtifactInsert({
    userId: ctx.userId,
    pickup: { lat: body.originLat, lng: body.originLng },
    dropoff: { lat: body.destLat, lng: body.destLng },
    stops: body.intermediateStops ?? [],
    distanceMeters: Number(result.distanceMeters),
    durationSeconds: Number(result.durationSeconds),
    provider: "mapbox_directions",
    profile,
    departureAt: safeDepartAt(body.departureTime),
    serviceAreaId: sa.serviceAreaId,
    nowMs: Date.now(),
  });
  const persisted = insert ? await persistRouteArtifact(ctx.admin, insert) : null;
  const artifactMs = Date.now() - started;
  return {
    ...result,
    routeQuoteId: persisted?.id ?? null,
    routeQuoteExpiresAt: persisted?.expires_at ?? null,
    serverServiceAreaId: sa.serviceAreaId,
    timings: result.timings ? { ...result.timings, artifactMs } : undefined,
  };
}

/** Short-lived in-isolate cache — identical coords reuse recent Mapbox result. */
const ROUTE_CACHE_TTL_MS = 120_000;
const ROUTE_CACHE_MAX = 64;
type RouteCacheEntry = { expiresAt: number; response: RouteResponse };
const routeCache = new Map<string, RouteCacheEntry>();

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

/** ~1.1 m precision — improves cache hits without materially wrong routes. */
function normalizeCoord(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

/** Only forward depart_at when Mapbox will accept it — bad values abort the whole request. */
function safeDepartAt(departureTime: string | undefined): string | null {
  if (!departureTime || typeof departureTime !== "string") return null;
  const ms = Date.parse(departureTime);
  if (!Number.isFinite(ms)) return null;
  const now = Date.now();
  if (ms < now - 5 * 60_000 || ms > now + 7 * 24 * 60 * 60_000) return null;
  return new Date(ms).toISOString();
}

function routeCacheKey(body: RouteRequest): string {
  const departAt = safeDepartAt(body.departureTime) ?? "";
  const stopKey = (body.intermediateStops ?? [])
    .map((s) => `${normalizeCoord(s.lat)},${normalizeCoord(s.lng)}`)
    .join(";");
  return [
    normalizeCoord(body.originLat),
    normalizeCoord(body.originLng),
    stopKey,
    normalizeCoord(body.destLat),
    normalizeCoord(body.destLng),
    departAt,
    body.includeGeometry === true ? "geo" : "pricing",
  ].join("|");
}

function readRouteCache(key: string): RouteResponse | null {
  const entry = routeCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    routeCache.delete(key);
    return null;
  }
  return {
    ...entry.response,
    timings: entry.response.timings
      ? { ...entry.response.timings, cacheHit: true }
      : undefined,
  };
}

function writeRouteCache(key: string, response: RouteResponse): void {
  if (routeCache.size >= ROUTE_CACHE_MAX) {
    const oldest = routeCache.keys().next().value;
    if (oldest) routeCache.delete(oldest);
  }
  routeCache.set(key, {
    expiresAt: Date.now() + ROUTE_CACHE_TTL_MS,
    response: { ...response, timings: response.timings ? { ...response.timings, cacheHit: false } : undefined },
  });
}

function buildMapboxParams(
  token: string,
  profile: "driving-traffic" | "driving",
  departAt: string | null,
  includeGeometry: boolean,
): URLSearchParams {
  const params = new URLSearchParams({
    access_token: token,
    alternatives: "false",
    steps: "false",
    overview: includeGeometry ? "full" : "false",
  });
  if (includeGeometry) {
    params.set("geometries", "polyline");
  }
  if (profile === "driving-traffic" && departAt) {
    params.set("depart_at", departAt);
  }
  return params;
}

/**
 * Mapbox Directions — pricing paths use lean params (no geometry/annotations).
 * Returns null when Mapbox cannot produce a route (caller may haversine).
 */
async function tryMapboxDirections(
  token: string,
  request: RouteRequest,
  profile: "driving-traffic" | "driving",
): Promise<{ response: RouteResponse | null; mapboxMs: number }> {
  const { originLat, originLng, destLat, destLng, intermediateStops, departureTime, includeGeometry } =
    request;
  const includeGeo = includeGeometry === true;
  const departAt = profile === "driving-traffic" ? safeDepartAt(departureTime) : null;

  const coords: string[] = [`${originLng},${originLat}`];
  for (const s of intermediateStops || []) {
    coords.push(`${s.lng},${s.lat}`);
  }
  coords.push(`${destLng},${destLat}`);

  const params = buildMapboxParams(token, profile, departAt, includeGeo);
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/${profile}/` +
    `${coords.join(";")}?${params}`;

  const mapboxStart = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const data = await response.json();
    const mapboxMs = Date.now() - mapboxStart;

    if (!response.ok || data.code !== "Ok" || !Array.isArray(data.routes) || data.routes.length === 0) {
      console.error("Mapbox Directions error:", profile, data?.code, data?.message, `${mapboxMs}ms`);
      return { response: null, mapboxMs };
    }

    const route = data.routes[0];
    const distanceMeters = Math.round(Number(route.distance) || 0);
    const durationSeconds = Math.round(Number(route.duration) || 0);

    console.log("Mapbox Directions success:", { profile, distanceMeters, durationSeconds, mapboxMs });

    return {
      mapboxMs,
      response: {
        success: true,
        distanceMeters,
        distanceKm: Math.round((distanceMeters / 1000) * 100) / 100,
        durationSeconds,
        durationMinutes: Math.ceil(durationSeconds / 60),
        polyline: includeGeo && typeof route.geometry === "string" ? route.geometry : undefined,
        source: "mapbox_directions",
      },
    };
  } catch (error) {
    const mapboxMs = Date.now() - mapboxStart;
    console.error("Mapbox Directions exception:", profile, error, `${mapboxMs}ms`);
    return { response: null, mapboxMs };
  }
}

async function resolveMapboxRoute(
  token: string,
  body: RouteRequest,
): Promise<{ response: RouteResponse | null; mapboxMs: number; profile: string | null }> {
  const departAt = safeDepartAt(body.departureTime);
  // Ride Now (no depart_at): skip driving-traffic — one Mapbox call instead of two.
  const profiles: Array<"driving-traffic" | "driving"> = departAt
    ? ["driving-traffic", "driving"]
    : ["driving"];

  let totalMapboxMs = 0;
  for (const profile of profiles) {
    const { response, mapboxMs } = await tryMapboxDirections(token, body, profile);
    totalMapboxMs += mapboxMs;
    if (response) {
      return { response, mapboxMs: totalMapboxMs, profile };
    }
  }
  return { response: null, mapboxMs: totalMapboxMs, profile: null };
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
      includeGeometry: raw.includeGeometry === true,
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
  const callerGate = await requireSignedInOrService(req);
  if (!callerGate.ok) return callerGate.response;

  const requestStart = Date.now();

  try {
    const token = Deno.env.get("MAPBOX_PUBLIC_TOKEN");

    const rawBody: RouteRequest = await req.json();
    const setupMs = Date.now() - requestStart;
    const norm = normalizeCoordinateBody(rawBody);
    if (!norm.ok) {
      console.warn("Route calculation invalid coordinates:", JSON.stringify(rawBody));
      return new Response(JSON.stringify(norm.response), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const body = norm.body;

    let artifactCtx: RouteArtifactContext | null = null;
    if (callerGate.userId) {
      const admin = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
        { auth: { persistSession: false } },
      );
      artifactCtx = {
        userId: callerGate.userId,
        admin,
        // Overlaps Mapbox; never on the critical path of the route itself.
        serviceAreaP: resolveServiceAreaIdForPickup(admin, {
          lat: body.originLat,
          lng: body.originLng,
        }).catch((err) => ({ ok: false as const, error: String(err) })),
      };
    }
    const respondRoute = async (result: RouteResponse, profile: string | null) => {
      const out = await attachRouteArtifact(artifactCtx, body, result, profile);
      if (out.timings) out.timings.totalMs = Date.now() - requestStart;
      return new Response(
        JSON.stringify(out),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    };

    if (!token) {
      console.error("MAPBOX_PUBLIC_TOKEN not configured");
      const fallback = getHaversineFallback(body);
      fallback.error = "Mapbox token not configured, using estimate";
      return new Response(
        JSON.stringify(fallback),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const cacheKey = routeCacheKey(body);
    const cached = readRouteCache(cacheKey);
    if (cached) {
      const totalMs = Date.now() - requestStart;
      cached.timings = {
        totalMs,
        setupMs,
        mapboxMs: 0,
        cacheHit: true,
        profile: cached.timings?.profile ?? null,
      };
      console.log("Route cache hit:", { cacheKey, totalMs });
      return await respondRoute(cached, cached.timings.profile);
    }

    console.log("Route calculation request:", {
      originLat: body.originLat,
      originLng: body.originLng,
      destLat: body.destLat,
      destLng: body.destLng,
      stops: body.intermediateStops?.length || 0,
      includeGeometry: body.includeGeometry === true,
    });

    const { response: mapboxResult, mapboxMs, profile } = await resolveMapboxRoute(token, body);

    let result = mapboxResult;

    if (!result) {
      console.log("Mapbox Directions failed, using Haversine fallback");
      result = getHaversineFallback(body);
      result.error = "Routing API unavailable, using distance estimate";
      result.errorCode = "MAPBOX_UNAVAILABLE";
    }

    const totalMs = Date.now() - requestStart;
    result.timings = {
      totalMs,
      setupMs,
      mapboxMs,
      cacheHit: false,
      profile,
    };

    if (result.source === "mapbox_directions") {
      writeRouteCache(cacheKey, result);
    }

    return await respondRoute(result, profile);
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
