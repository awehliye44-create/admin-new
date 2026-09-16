/**
 * scheduled-checkin
 *
 * Backend-validated check-in for confirmed scheduled rides.
 * Replaces the raw client-side Supabase update in useScheduledJobs.confirmCheckIn().
 *
 * Validates:
 *   1. Caller is the confirmed_driver_id (or current driver_id) for this trip
 *   2. Trip is not cancelled, completed, or otherwise terminal
 *   3. Trip is in a state that allows check-in
 *      (scheduled_committed, driver_assigned, or scheduled with valid scheduled_status)
 *   4. Driver is within the allowed check-in radius of the pickup location
 *   5. Trip is within the valid check-in time window
 *
 * On success:
 *   - Sets driver_id = confirmed_driver_id
 *   - Sets status = "en_route_to_pickup"
 *   - Sets scheduled_status = "driver_en_route"
 *   - Notifies customer: driver is on the way
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  handleCORSPreflight,
  successResponse,
  errorResponse,
  jsonHeaders,
  securityHeaders,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
} from "../_shared/security.ts";
import { haversineKm } from "../_shared/scheduledDispatchConfig.ts";

const RATE_LIMIT_CONFIG = { limit: 20, windowMs: 60_000, keyPrefix: "scheduled-checkin" };

/** Maximum distance from pickup for a valid check-in (metres). */
const MAX_CHECKIN_RADIUS_METRES = 300;

/** Check-in window: how many minutes before pickup the window opens. */
const CHECKIN_WINDOW_OPENS_MINUTES_BEFORE_PICKUP = 20;

/** How many minutes past pickup the window stays open (grace for late arrivals). */
const CHECKIN_WINDOW_GRACE_AFTER_PICKUP_MINUTES = 15;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) return rateLimitResponse(rateLimitResult);

  try {
    // ── Auth ─────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("UNAUTHORIZED", "Missing or invalid Authorization header", 401);
    }
    const token = authHeader.slice(7);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify JWT and get calling user
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user) {
      return errorResponse("UNAUTHORIZED", "Invalid token", 401);
    }
    const userId = userData.user.id;

    // Resolve driver record
    const { data: driverRow, error: driverError } = await supabase
      .from("drivers")
      .select("id, first_name, last_name")
      .eq("user_id", userId)
      .single();

    if (driverError || !driverRow) {
      return errorResponse("FORBIDDEN", "Driver profile not found", 403);
    }
    const driverId = driverRow.id;

    // ── Parse body ───────────────────────────────────────────────────────────
    let body: {
      trip_id: string;
      driver_lat?: number | null;
      driver_lng?: number | null;
    };
    try {
      body = await req.json();
    } catch {
      return errorResponse("INVALID_BODY", "Request body must be JSON", 400);
    }

    const { trip_id, driver_lat, driver_lng } = body;

    if (!trip_id || typeof trip_id !== "string") {
      return errorResponse("VALIDATION_ERROR", "trip_id is required", 400);
    }

    // ── Fetch trip ───────────────────────────────────────────────────────────
    const { data: trip, error: tripError } = await supabase
      .from("trips")
      .select(
        "id, status, scheduled_status, is_scheduled, dispatch_mode, driver_id, confirmed_driver_id, scheduled_at, pickup_latitude, pickup_longitude, passenger_id, pickup_address, scheduled_committed_at",
      )
      .eq("id", trip_id)
      .single();

    if (tripError || !trip) {
      return errorResponse("NOT_FOUND", "Trip not found", 404);
    }

    // ── Guard 1: terminal state ───────────────────────────────────────────────
    const TERMINAL_STATUSES = new Set([
      "completed", "cancelled", "customer_cancelled", "driver_cancelled",
      "no_show", "expired_no_driver", "expired",
    ]);
    if (TERMINAL_STATUSES.has(trip.status)) {
      return errorResponse("INVALID_STATE", `Trip is already ${trip.status}`, 409);
    }

    // ── Guard 2: driver owns this trip ────────────────────────────────────────
    const isConfirmedDriver = trip.confirmed_driver_id === driverId;
    const isAssignedDriver = trip.driver_id === driverId;
    if (!isConfirmedDriver && !isAssignedDriver) {
      return errorResponse("FORBIDDEN", "You are not assigned to this trip", 403);
    }

    // ── Guard 3: valid check-in state ─────────────────────────────────────────
    // Allow check-in from: scheduled_committed (new path), driver_assigned, or
    // the legacy en_route_to_pickup (idempotent).
    const CHECKIN_ALLOWED_STATUSES = new Set([
      "scheduled_committed",
      "driver_assigned",
      "en_route_to_pickup",
    ]);
    if (!CHECKIN_ALLOWED_STATUSES.has(trip.scheduled_status ?? "")) {
      return errorResponse(
        "INVALID_STATE",
        `Cannot check in — trip is in state: ${trip.scheduled_status}`,
        409,
      );
    }

    // Idempotent: if already en_route, return success immediately
    if (trip.scheduled_status === "driver_en_route" || trip.status === "en_route_to_pickup") {
      return successResponse({ success: true, already_checked_in: true });
    }

    // ── Guard 4: check-in time window ─────────────────────────────────────────
    const now = new Date();
    const nowMs = now.getTime();
    const pickupMs = Date.parse(trip.scheduled_at);
    const windowOpensMs = pickupMs - CHECKIN_WINDOW_OPENS_MINUTES_BEFORE_PICKUP * 60_000;
    const windowClosesMs = pickupMs + CHECKIN_WINDOW_GRACE_AFTER_PICKUP_MINUTES * 60_000;

    if (nowMs < windowOpensMs) {
      const minutesUntilWindow = Math.ceil((windowOpensMs - nowMs) / 60_000);
      return errorResponse(
        "TOO_EARLY",
        `Check-in window opens in ${minutesUntilWindow} minutes.`,
        409,
      );
    }
    if (nowMs > windowClosesMs) {
      return errorResponse(
        "WINDOW_CLOSED",
        "Check-in window has closed. The trip may have expired.",
        409,
      );
    }

    // ── Guard 5: proximity check ──────────────────────────────────────────────
    // Only enforce if trip has pickup coordinates and driver provided location.
    // If no driver location is provided by the client (e.g. GPS unavailable),
    // we allow check-in anyway to avoid blocking the driver.
    if (
      driver_lat != null && driver_lng != null &&
      trip.pickup_latitude != null && trip.pickup_longitude != null
    ) {
      const distanceKm = haversineKm(
        driver_lat, driver_lng,
        trip.pickup_latitude, trip.pickup_longitude,
      );
      const distanceMetres = distanceKm * 1000;

      if (distanceMetres > MAX_CHECKIN_RADIUS_METRES) {
        return errorResponse(
          "TOO_FAR",
          `You must be within ${MAX_CHECKIN_RADIUS_METRES}m of the pickup to check in. Current distance: ${Math.round(distanceMetres)}m.`,
          409,
        );
      }
    }

    // ── All guards passed — commit check-in ──────────────────────────────────
    const { error: updateError } = await supabase
      .from("trips")
      .update({
        driver_id: driverId,
        status: "en_route_to_pickup",
        scheduled_status: "driver_en_route",
        updated_at: now.toISOString(),
      })
      .eq("id", trip_id)
      .or(`confirmed_driver_id.eq.${driverId},driver_id.eq.${driverId}`);

    if (updateError) {
      console.error("[scheduled-checkin] Update failed:", updateError);
      return errorResponse("DATABASE_ERROR", updateError.message, 500);
    }

    console.log("SCHEDULED_CHECKIN_SUCCESS", {
      trip_id,
      driver_id: driverId,
      scheduled_at: trip.scheduled_at,
      driver_lat,
      driver_lng,
      pickup_lat: trip.pickup_latitude,
      pickup_lng: trip.pickup_longitude,
    });

    // Notify customer: driver is on the way
    if (trip.passenger_id) {
      try {
        const driverName = driverRow.first_name?.trim() ?? "Your driver";
        const { notifyCustomerTripLifecycle } = await import(
          "../_shared/customerTripLifecycleNotify.ts"
        );
        await notifyCustomerTripLifecycle(supabase, {
          passengerId: trip.passenger_id,
          tripId: trip_id,
          event: "driver_assigned",
          title: "Your driver is on the way",
          body: `${driverName} is heading to your pickup at ${trip.pickup_address ?? "your location"}.`,
          notificationId: `driver_assigned-${trip_id}-scheduled_checkin`,
        });
      } catch (notifErr) {
        console.warn("[scheduled-checkin] Customer notification failed:", notifErr);
      }
    }

    return successResponse({ success: true, checked_in: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    console.error("[scheduled-checkin] Error:", err);
    return errorResponse("INTERNAL_ERROR", msg, 500);
  }
});
