import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  securityHeaders,
  jsonHeaders,
  handleCORSPreflight,
  checkRateLimit,
  rateLimitResponse,
  getClientIP,
  successResponse,
  errorResponse,
  isPositiveNumber,
} from "../_shared/security.ts";

// Rate limit: 60 requests per minute (for cron jobs)
const RATE_LIMIT_CONFIG = { limit: 60, windowMs: 60000, keyPrefix: 'expire-stale-drivers' };

/**
 * Expire Stale Drivers
 *
 * Marks idle drivers (no current_trip) offline when `last_heartbeat_at` exceeds
 * the TTL. Default TTL is **60s** — matches `expire_stale_drivers` in Postgres
 * and clears misleading `drivers.is_online` shortly after heartbeat stops.
 * Dispatch still uses ~45s eligibility; this watchdog fixes UI/backend drift.
 *
 * Should be called periodically (e.g., every 30 seconds) via cron or scheduler.
 */
Deno.serve(async (req) => {
  console.log("[expire-stale-drivers] Received request:", req.method);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  // Rate limiting
  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    console.warn("[expire-stale-drivers] Rate limit exceeded for IP:", clientIP);
    return rateLimitResponse(rateLimitResult);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Parse optional TTL from request body with validation
    let ttlSeconds = 60; // Align with DB `expire_stale_drivers` default

    try {
      const body = await req.json();
      if (body.ttl_seconds !== undefined) {
        if (isPositiveNumber(body.ttl_seconds)) {
          ttlSeconds = Math.max(60, Math.min(600, body.ttl_seconds)); // Clamp 60-600s
        } else {
          console.warn("[expire-stale-drivers] Invalid ttl_seconds, using default");
        }
      }
    } catch {
      // No body or invalid JSON, use default
    }

    console.log("[expire-stale-drivers] Using TTL:", ttlSeconds, "seconds");

    // Call the database function to expire stale drivers
    const { data, error } = await supabase.rpc('expire_stale_drivers', {
      p_ttl_seconds: ttlSeconds,
    });

    if (error) {
      console.error("[expire-stale-drivers] Error expiring stale drivers:", error);
      return errorResponse(
        "DB_ERROR",
        "Failed to expire stale drivers",
        500,
        error.message
      );
    }

    const expiredCount = data ?? 0;
    console.log("[expire-stale-drivers] Expired", expiredCount, "stale drivers");

    return successResponse({
      success: true,
      expired_count: expiredCount,
      ttl_seconds: ttlSeconds,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[expire-stale-drivers] Unexpected error:", err);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
