import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  handleCORSPreflight,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import { handleStackedTripsOnDriverOffline } from "../_shared/stackedRideLifecycle.ts";

const RATE_LIMIT_CONFIG = {
  limit: 20,
  windowMs: 60_000,
  keyPrefix: "stacked-ride-driver-offline",
};

/**
 * Orphan prevention when a driver goes offline with queued Trip B linked to Trip A.
 * Safe while stacked rides are disabled — no-op when no stacked_trip_id.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return errorResponse("UNAUTHENTICATED", "Missing bearer token", 401);
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) {
      return errorResponse("UNAUTHENTICATED", "Invalid session", 401);
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const { data: driver } = await supabase
      .from("drivers")
      .select("id")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (!driver) return errorResponse("FORBIDDEN", "Not a driver", 403);

    const result = await handleStackedTripsOnDriverOffline(supabase, driver.id);

    return successResponse({
      success: true,
      driver_id: driver.id,
      stacked_lifecycle: result,
    });
  } catch (err) {
    console.error("[stacked-ride-driver-offline]", err);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
