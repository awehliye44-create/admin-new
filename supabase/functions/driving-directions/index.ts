/**
 * driving-directions Edge Function
 *
 * Proxies Google Directions API requests so the server-side API key
 * never reaches the client bundle.  Auth is validated in-code (the
 * function is deployed with verify_jwt = false).
 *
 * Hardening (April 2026):
 *  - Per-driver rate limiting (20 req / 60 s)
 *  - Coordinate & payload validation
 *  - Waypoint cap (10)
 *  - Google error logging (status + error_message, no secrets)
 *  - Non-retryable status forwarded with x-directions-retryable: false
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

import { requireAuthenticatedUser } from "../_shared/edgeAuth.ts";

// ---- CORS ----
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version, x-supabase-client-timezone",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extra },
  });
}

// ---- Rate limiter (in-memory, per isolate) ----
const RL_LIMIT = 20;
const RL_WINDOW_MS = 60_000;

interface RLEntry { count: number; resetAt: number }
const rlStore = new Map<string, RLEntry>();
let lastRLCleanup = Date.now();

function checkRL(id: string): { ok: boolean; remaining: number; retryAfter?: number } {
  const now = Date.now();
  if (now - lastRLCleanup > 60_000) {
    lastRLCleanup = now;
    for (const [k, v] of rlStore) if (v.resetAt < now) rlStore.delete(k);
  }
  let e = rlStore.get(id);
  if (!e || e.resetAt < now) e = { count: 0, resetAt: now + RL_WINDOW_MS };
  e.count++;
  rlStore.set(id, e);
  const remaining = Math.max(0, RL_LIMIT - e.count);
  if (e.count > RL_LIMIT) {
    return { ok: false, remaining, retryAfter: Math.ceil((e.resetAt - now) / 1000) };
  }
  return { ok: true, remaining };
}

// ---- Validation helpers ----
function validLat(v: unknown): v is number { return typeof v === "number" && v >= -90 && v <= 90; }
function validLng(v: unknown): v is number { return typeof v === "number" && v >= -180 && v <= 180; }
const MAX_WAYPOINTS = 10;

const NON_RETRYABLE = new Set([
  "REQUEST_DENIED",
  "OVER_QUERY_LIMIT",
  "INVALID_REQUEST",
  "MAX_WAYPOINTS_EXCEEDED",
  "NOT_FOUND",
  "UNKNOWN_ERROR",
]);

// ---- Handler ----
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLIC_KEY")!;
  const auth = await requireAuthenticatedUser(req, supabaseUrl, supabaseAnonKey);
  if (!auth.ok) {
    return auth.response;
  }
  const userId = auth.userId;

  // ---- Rate limit (keyed by userId) ----
  const rl = checkRL(userId);
  if (!rl.ok) {
    console.warn(`[driving-directions] rate-limited user=${userId}`);
    return json(
      { error: "RATE_LIMIT_EXCEEDED", message: "Too many requests", retryAfter: rl.retryAfter },
      429,
      { "Retry-After": String(rl.retryAfter ?? 60) },
    );
  }

  // ---- Verify driver row ----
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceKey);

  const { data: driver, error: driverErr } = await sb
    .from("drivers")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  if (driverErr) {
    console.error("[driving-directions] driver lookup error", driverErr);
    return json({ error: "Internal error" }, 500);
  }
  if (!driver) return json({ error: "Driver profile required" }, 403);

  // ---- Parse & validate body ----
  let body: {
    origin: { lat: number; lng: number };
    destination: { lat: number; lng: number };
    waypoints?: { lat: number; lng: number }[];
    mode?: string;
    avoid?: string;
  };

  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { origin, destination, waypoints, mode, avoid } = body;

  if (!validLat(origin?.lat) || !validLng(origin?.lng)) {
    return json({ error: "Invalid origin coordinates" }, 400);
  }
  if (!validLat(destination?.lat) || !validLng(destination?.lng)) {
    return json({ error: "Invalid destination coordinates" }, 400);
  }
  if (waypoints) {
    if (!Array.isArray(waypoints)) return json({ error: "waypoints must be an array" }, 400);
    if (waypoints.length > MAX_WAYPOINTS) {
      return json({ error: `Max ${MAX_WAYPOINTS} waypoints allowed` }, 400);
    }
    for (const w of waypoints) {
      if (!validLat(w?.lat) || !validLng(w?.lng)) {
        return json({ error: "Invalid waypoint coordinates" }, 400);
      }
    }
  }
  if (mode && !["driving", "walking", "bicycling", "transit"].includes(mode)) {
    return json({ error: "Invalid mode" }, 400);
  }

  // ---- Build Google Directions URL ----
  const apiKey = Deno.env.get("GOOGLE_MAPS_DIRECTIONS_SERVER_KEY");
  if (!apiKey) {
    console.error("[driving-directions] GOOGLE_MAPS_DIRECTIONS_SERVER_KEY not set");
    return json({ error: "Server configuration error" }, 500);
  }

  const params = new URLSearchParams({
    origin: `${origin.lat},${origin.lng}`,
    destination: `${destination.lat},${destination.lng}`,
    mode: mode || "driving",
    key: apiKey,
  });

  if (avoid) params.set("avoid", avoid);
  if (waypoints && waypoints.length > 0) {
    params.set("waypoints", waypoints.map((w) => `${w.lat},${w.lng}`).join("|"));
  }

  const url = `https://maps.googleapis.com/maps/api/directions/json?${params}`;

  // ---- Proxy to Google ----
  try {
    const gRes = await fetch(url);
    const gJson = await gRes.json();

    const gStatus: string = gJson.status ?? "UNKNOWN";
    const retryable = !NON_RETRYABLE.has(gStatus);

    // Structured log — never includes the API key
    console.log(
      `[driving-directions] driver=${driver.id} google_status=${gStatus}` +
      (gJson.error_message ? ` error_message="${gJson.error_message}"` : "") +
      ` remaining=${rl.remaining}`,
    );

    return json(gJson, gRes.ok ? 200 : 502, {
      "x-directions-retryable": String(retryable),
    });
  } catch (err) {
    console.error("[driving-directions] Google fetch error", err);
    return json({ error: "Upstream error" }, 502);
  }
});
