import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  handleCORSPreflight,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  isValidUUID,
  validationErrorResponse,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";

const RATE_LIMIT_CONFIG = { limit: 120, windowMs: 60000, keyPrefix: "booking-received" };

/**
 * POST booking_received for a ride (trip id = booking id).
 * Resolves pending offer for the authenticated driver and calls ack_offer_delivery(..., 'http').
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl);

  if (req.method !== "POST") {
    return errorResponse("METHOD_NOT_ALLOWED", "Use POST", 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("UNAUTHORIZED", "Missing authorization header", 401);
    }

    const raw = await req.json().catch(() => ({}));
    const booking_id = typeof raw?.booking_id === "string"
      ? raw.booking_id
      : typeof raw?.bookingId === "string"
        ? raw.bookingId
        : "";

    const client_driver_id = typeof raw?.driver_id === "string" ? raw.driver_id.trim() : "";
    const telemetry_source =
      typeof raw?.source === "string" ? raw.source.slice(0, 64) : "";
    const telemetry_app_state =
      typeof raw?.app_state === "string" ? raw.app_state.slice(0, 32) : "";
    const telemetry_timestamp =
      typeof raw?.timestamp === "string" ? raw.timestamp.slice(0, 64) : "";

    const errors: Record<string, string> = {};
    if (!booking_id) errors.booking_id = "booking_id is required";
    else if (!isValidUUID(booking_id)) errors.booking_id = "must be a valid UUID";
    if (Object.keys(errors).length) return validationErrorResponse(errors);

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return errorResponse("UNAUTHORIZED", "Invalid session", 401);
    }

    const { data: driverRow } = await userClient.from("drivers")
      .select("id")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (!driverRow?.id) {
      return errorResponse("FORBIDDEN", "Not a driver account", 403);
    }

    if (client_driver_id && client_driver_id !== driverRow.id) {
      return errorResponse("FORBIDDEN", "driver_id does not match session", 403);
    }

    const adminClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });

    if (raw?.diagnose === true) {
      const { data: recentOffers } = await adminClient.from("ride_offers")
        .select("id, trip_id, driver_id, status, expires_at, created_at")
        .order("created_at", { ascending: false })
        .limit(10);

      const { data: recentTrips } = await adminClient.from("trips")
        .select("id, status, dispatch_status, driver_id, confirmed_driver_id, created_at")
        .order("created_at", { ascending: false })
        .limit(10);

      let validationResult = null;
      if (recentOffers && recentOffers.length > 0) {
        const { data: valData } = await adminClient.rpc("validate_driver_offer", {
          p_offer_id: recentOffers[0].id,
          p_driver_id: driverRow.id
        });
        validationResult = valData;
      }

      return successResponse({
        ok: true,
        diagnose: true,
        driver_id: driverRow.id,
        validationResult,
        recentOffers,
        recentTrips
      });
    }

    console.log(
      `[booking-received] booking_id=${booking_id} driver=${driverRow.id}` +
      (telemetry_source ? ` source=${telemetry_source}` : "") +
      (telemetry_app_state ? ` app_state=${telemetry_app_state}` : "") +
      (telemetry_timestamp ? ` ts=${telemetry_timestamp}` : ""),
    );

    const { data: offerRow } = await adminClient.from("ride_offers")
      .select("id, status")
      .eq("trip_id", booking_id)
      .eq("driver_id", driverRow.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!offerRow?.id) {
      return errorResponse(
        "NOT_FOUND",
        "No offer found for this booking and driver",
        404,
      );
    }

    const { data: ack, error: ackErr } = await userClient.rpc("ack_offer_delivery", {
      p_offer_id: offerRow.id,
      p_method: "http",
    });

    if (ackErr) {
      console.error("[booking-received] ack_offer_delivery RPC error:", ackErr);
      return errorResponse("RPC_ERROR", ackErr.message ?? "ACK failed", 500);
    }

    if (!(ack as { success?: boolean })?.success) {
      return successResponse({
        ok: false,
        booking_id,
        offer_id: offerRow.id,
        ack,
      }, 422);
    }

    const firstAck = !!(ack && typeof ack === "object" && (ack as { first_ack?: boolean }).first_ack);
    console.log(
      `[booking_delivery] booking_received booking_id=${booking_id} offer_id=${offerRow.id} driver_id=${driverRow.id} channel=http first_write=${firstAck}`,
    );

    return successResponse({
      ok: true,
      booking_id,
      offer_id: offerRow.id,
      ack,
    });
  } catch (e) {
    console.error("[booking-received]", e);
    return errorResponse("INTERNAL_ERROR", String(e), 500);
  }
});
