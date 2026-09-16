/**
 * trip-route — Single backend endpoint for all route/ETA operations.
 * 
 * Actions:
 *   get_route    — Returns cached route or computes fresh one
 *   check_reroute — Checks if reroute triggers are met, reroutes if needed
 *   invalidate   — Clears cache for a trip (e.g., destination changed)
 *
 * This is the ONLY place that calls Google Directions API.
 * Frontend apps MUST call this instead of Google directly.
 */

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
import {
  getRouteWithCache,
  checkRerouteTrigger,
  invalidateRouteCache,
  type RouteLeg,
  type RerouteReason,
} from "../_shared/routeCache.ts";

const RATE_LIMIT_CONFIG = { limit: 60, windowMs: 60 * 1000 };

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter!);

  try {
    const body = await req.json();
    const { action } = body;

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    switch (action) {
      case "get_route": {
        const { trip_id, leg, origin_lat, origin_lng, dest_lat, dest_lng, reason, force_refresh, waypoints } = body;
        if (!trip_id || !leg || origin_lat == null || origin_lng == null || dest_lat == null || dest_lng == null) {
          return errorResponse("Missing required fields: trip_id, leg, origin/dest coordinates", 400);
        }

        const route = await getRouteWithCache(
          supabase, trip_id, leg as RouteLeg,
          origin_lat, origin_lng, dest_lat, dest_lng,
          (reason as RerouteReason) || "trip_assigned",
          force_refresh || false,
          waypoints
        );

        return successResponse({ route });
      }

      case "check_reroute": {
        const { trip_id, leg, driver_lat, driver_lng, current_duration_estimate_min } = body;
        if (!trip_id || !leg || driver_lat == null || driver_lng == null) {
          return errorResponse("Missing required fields for reroute check", 400);
        }

        // Fetch current cache
        const { data: cached } = await supabase
          .from("trip_route_cache")
          .select("origin_lat, origin_lng, dest_lat, dest_lng, eta_at, duration_min")
          .eq("trip_id", trip_id)
          .eq("leg", leg)
          .maybeSingle();

        if (!cached) {
          return successResponse({ rerouted: false, reason: "no_cache", message: "No cached route to compare" });
        }

        const triggerReason = checkRerouteTrigger(
          driver_lat, driver_lng,
          cached.origin_lat, cached.origin_lng,
          cached.eta_at,
          current_duration_estimate_min ?? cached.duration_min
        );

        if (!triggerReason) {
          return successResponse({ rerouted: false, reason: null, message: "No reroute needed" });
        }

        // Trigger met — recalculate route from driver's current position
        console.log(`[trip-route] Reroute triggered: ${triggerReason} for trip ${trip_id} leg ${leg}`);

        const newRoute = await getRouteWithCache(
          supabase, trip_id, leg as RouteLeg,
          driver_lat, driver_lng,
          cached.dest_lat, cached.dest_lng,
          triggerReason,
          true // force refresh
        );

        return successResponse({ rerouted: true, reason: triggerReason, route: newRoute });
      }

      case "invalidate": {
        const { trip_id, leg } = body;
        if (!trip_id) return errorResponse("Missing trip_id", 400);

        await invalidateRouteCache(supabase, trip_id, leg as RouteLeg | undefined);
        return successResponse({ invalidated: true });
      }

      default:
        return errorResponse(`Unknown action: ${action}. Use get_route, check_reroute, or invalidate.`, 400);
    }
  } catch (err) {
    console.error("[trip-route] Error:", err);
    return errorResponse(err instanceof Error ? err.message : "Unknown error", 500);
  }
});
