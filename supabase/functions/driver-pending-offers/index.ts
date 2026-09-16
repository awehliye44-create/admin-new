import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  handleCORSPreflight,
  checkRateLimit,
  getClientIP,
  isValidUUID,
  rateLimitResponse,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";

const RATE_LIMIT_CONFIG = { limit: 120, windowMs: 60000, keyPrefix: "driver-pending-offers" };

/**
 * GET pending ride offers + trip rows for authenticated driver (HTTP recovery).
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl);

  if (req.method !== "GET") {
    return errorResponse("METHOD_NOT_ALLOWED", "Use GET", 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("UNAUTHORIZED", "Missing authorization header", 401);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return errorResponse("UNAUTHORIZED", "Invalid session", 401);
    }

    const { data, error } = await userClient.rpc("get_driver_pending_ride_offers");

    if (error) {
      console.error("[driver-pending-offers] RPC error:", error);
      return errorResponse("RPC_ERROR", error.message ?? "Failed to load pending offers", 500);
    }

    let parsed: unknown = data ?? [];
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        parsed = [];
      }
    }

    let count = 0;
    if (Array.isArray(parsed)) count = parsed.length;

    console.log("[delivery] pending_offers_http ok count=" + count);
    console.log("[booking_delivery] pending_offers_fallback layer=driver_pending_offers_edge count=" + count);

    if (
      Array.isArray(parsed) &&
      count > 0 &&
      parsed[0] &&
      typeof parsed[0] === "object"
    ) {
      const row = parsed[0] as { offer?: { id?: string; driver_id?: string }; trip?: { id?: string } };
      const bookingId =
        typeof row.trip?.id === "string" ? row.trip.id : "";
      const driverId =
        typeof row.offer?.driver_id === "string"
          ? row.offer.driver_id
          : "";
      const offerId = typeof row.offer?.id === "string" ? row.offer.id : null;
      if (bookingId && driverId && isValidUUID(bookingId) && isValidUUID(driverId)) {
        const { error: bdlErr } = await userClient.rpc("record_booking_delivery", {
          p_booking_id: bookingId,
          p_phase: "pending_offers_fallback",
          p_driver_id: driverId,
          p_offer_id: offerId,
          p_source: "edge",
          p_detail: { layer: "driver_pending_offers_edge", pending_count: count },
        });
        if (bdlErr) {
          console.warn("[driver-pending-offers] record_booking_delivery failed:", bdlErr);
        }
      }
    }

    return successResponse({ offers: parsed ?? [] });
  } catch (e) {
    console.error("[driver-pending-offers]", e);
    return errorResponse("INTERNAL_ERROR", String(e), 500);
  }
});
