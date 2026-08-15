/**
 * Driver app: sync negotiation countdown expiry server-side.
 *
 * waiting_customer timeout → Driver second chance at original £X
 * waiting_driver_final / declined_customer_awaiting_driver timeout → exclude driver + rebroadcast
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  handleCORSPreflight,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  isValidUUID,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import { finalizeNegotiationFailureAndRebroadcast } from "../_shared/negotiationFailureRematch.ts";
import { enterDriverSecondChanceAtOriginalFare } from "../_shared/customerNegotiationGrace.ts";
import { notifyDriverTripStopped } from "../_shared/notifyDriverTripStopped.ts";

const RATE_LIMIT_CONFIG = {
  limit: 40,
  windowMs: 60000,
  keyPrefix: "driver-negotiation-sync",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return errorResponse("UNAUTHORIZED", "Missing authorization", 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: { user }, error: authError } = await userClient.auth.getUser(token);
    if (authError || !user) return errorResponse("UNAUTHORIZED", "Invalid token", 401);

    const body = await req.json() as { offer_id?: string; driver_id?: string };
    const offerId = body.offer_id;
    const driverId = body.driver_id;

    if (!offerId || !isValidUUID(offerId)) {
      return errorResponse("VALIDATION_ERROR", "Valid offer_id required", 400);
    }
    if (!driverId || !isValidUUID(driverId)) {
      return errorResponse("VALIDATION_ERROR", "Valid driver_id required", 400);
    }

    const { data: driver } = await supabase
      .from("drivers")
      .select("id, user_id")
      .eq("id", driverId)
      .maybeSingle();

    if (!driver || driver.user_id !== user.id) {
      return errorResponse("FORBIDDEN", "Not your driver profile", 403);
    }

    const { data: offer, error: offerErr } = await supabase
      .from("ride_offers")
      .select(
        "id, trip_id, driver_id, status, negotiation_status, customer_respond_by, driver_respond_by, grace_window_expires_at",
      )
      .eq("id", offerId)
      .eq("driver_id", driverId)
      .maybeSingle();

    if (offerErr || !offer) return errorResponse("NOT_FOUND", "Offer not found", 404);

    const now = Date.now();
    const ns = offer.negotiation_status ?? "";
    const alreadyResolved =
      offer.status === "accepted"
      || offer.status === "revoked"
      || ns === "confirmed";

    if (alreadyResolved) {
      return successResponse({ success: true, action: "already_resolved", trip_id: offer.trip_id });
    }

    if (ns === "waiting_customer" && offer.customer_respond_by) {
      if (new Date(offer.customer_respond_by).getTime() > now) {
        return successResponse({ success: true, action: "not_expired_yet", trip_id: offer.trip_id });
      }

      const result = await enterDriverSecondChanceAtOriginalFare(supabase, {
        offer_id: offerId,
        trip_id: offer.trip_id,
        driver_id: driverId,
        reason: "timeout_customer",
      });

      return successResponse({
        success: result.ok,
        action: "driver_second_chance",
        trip_id: offer.trip_id,
        negotiation_status: "declined_customer_awaiting_driver",
        negotiation_expires_at: result.negotiation_expires_at,
        original_fare_pence: result.original_fare_pence,
      });
    }

    if (ns === "declined_customer_awaiting_driver") {
      // Only guard against early calls if we have an explicit deadline.
      if (offer.grace_window_expires_at && new Date(offer.grace_window_expires_at).getTime() > now) {
        return successResponse({ success: true, action: "not_expired_yet", trip_id: offer.trip_id });
      }

      const rematch = await finalizeNegotiationFailureAndRebroadcast(supabase, {
        tripId: offer.trip_id,
        failedDriverId: driverId,
        offerId,
        offerTerminalStatus: "expired",
        offerNegotiationStatus: "timeout_driver",
      });

      await notifyDriverTripStopped(supabaseUrl, serviceRoleKey, driverId, {
        tripId: offer.trip_id,
        stopReason: "negotiation_expired",
        cancelledBy: "system",
        body: "Negotiation ended — waiting for next offer",
      });

      return successResponse({
        success: rematch.success,
        action: "grace_expired_rebroadcast",
        trip_id: offer.trip_id,
      });
    }

    if (ns === "waiting_driver_final" && offer.driver_respond_by) {
      if (new Date(offer.driver_respond_by).getTime() > now) {
        return successResponse({ success: true, action: "not_expired_yet", trip_id: offer.trip_id });
      }

      const rematch = await finalizeNegotiationFailureAndRebroadcast(supabase, {
        tripId: offer.trip_id,
        failedDriverId: driverId,
        offerId,
        offerTerminalStatus: "expired",
        offerNegotiationStatus: "timeout_driver",
      });

      await notifyDriverTripStopped(supabaseUrl, serviceRoleKey, driverId, {
        tripId: offer.trip_id,
        stopReason: "negotiation_expired",
        body: "Counter-offer window ended",
      });

      return successResponse({
        success: rematch.success,
        action: "counter_timeout_rebroadcast",
        trip_id: offer.trip_id,
      });
    }

    if (
      ns === "timeout_driver"
      || ns === "timeout_customer"
      || ns === "declined_driver"
      || offer.status === "expired"
      || offer.status === "declined"
    ) {
      return successResponse({
        success: true,
        action: "already_resolved",
        trip_id: offer.trip_id,
      });
    }

    return successResponse({ success: true, action: "no_op", trip_id: offer.trip_id });
  } catch (err) {
    console.error("[driver-negotiation-sync] Error:", err);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
