import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  securityHeaders,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  errorResponse,
  successResponse,
} from "../_shared/security.ts";

// Rate limit: 30 requests per 10 seconds per driver (location updates every 3-5s)
const RATE_LIMIT_CONFIG = { limit: 30, windowMs: 10 * 1000 };

// Base32 encoding for geohash
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

function encodeGeohash(lat: number, lng: number, precision = 6): string {
  let idx = 0;
  let bit = 0;
  let evenBit = true;
  let geohash = "";
  let minLat = -90, maxLat = 90;
  let minLng = -180, maxLng = 180;

  while (geohash.length < precision) {
    if (evenBit) {
      const midLng = (minLng + maxLng) / 2;
      if (lng >= midLng) { idx = idx * 2 + 1; minLng = midLng; }
      else { idx = idx * 2; maxLng = midLng; }
    } else {
      const midLat = (minLat + maxLat) / 2;
      if (lat >= midLat) { idx = idx * 2 + 1; minLat = midLat; }
      else { idx = idx * 2; maxLat = midLat; }
    }
    evenBit = !evenBit;
    if (++bit === 5) {
      geohash += BASE32[idx];
      bit = 0;
      idx = 0;
    }
  }
  return geohash;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let body: {
      driver_id: string;
      lat: number;
      lng: number;
      speed?: number;
      heading?: number;
      timestamp?: number;
    };

    try {
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON", 400);
    }

    const { driver_id, lat, lng, speed, heading, timestamp } = body;

    // Validate required fields
    if (!driver_id || typeof lat !== "number" || typeof lng !== "number") {
      return errorResponse("Missing driver_id, lat, or lng", 400);
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return errorResponse("Invalid coordinates", 400);
    }

    // Reject stale updates older than 60 seconds
    if (timestamp) {
      const age = Date.now() - timestamp;
      if (age > 60_000) {
        return errorResponse("Stale location update rejected (>60s old)", 400);
      }
    }

    // Rate limit per driver
    const clientIP = getClientIP(req);
    const rateLimitKey = `loc:${driver_id}`;
    const rl = checkRateLimit(rateLimitKey, RATE_LIMIT_CONFIG);
    if (!rl.allowed) {
      return rateLimitResponse(rl.retryAfter!);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const geohash6 = encodeGeohash(lat, lng, 6);

    // Upsert using raw SQL via RPC for PostGIS geography type
    const { error } = await supabase.rpc("upsert_driver_live_location", {
      p_driver_id: driver_id,
      p_lat: lat,
      p_lng: lng,
      p_geohash6: geohash6,
      p_speed: speed ?? null,
      p_heading: heading ?? null,
    });

    if (error) {
      console.error("[upsert-driver-location] Error:", error);
      return errorResponse("Failed to update location", 500);
    }

    return successResponse({ updated: true, geohash6 });
  } catch (err) {
    console.error("[upsert-driver-location] Error:", err);
    return errorResponse(
      err instanceof Error ? err.message : "Unknown error",
      500
    );
  }
});
