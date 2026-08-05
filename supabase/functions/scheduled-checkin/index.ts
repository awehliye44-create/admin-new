/**
 * scheduled-checkin
 *
 * Backend-validated check-in / Start journey for confirmed scheduled rides.
 *
 * Actions:
 *   - check_in: future commitment readiness only (sets driver_checked_in_at).
 *     Does NOT activate the trip / does NOT set driver_id or en_route.
 *   - start_journey: activate trip → DRIVER_ASSIGNED/en_route_to_pickup and
 *     head to pickup.
 *
 * Body: { trip_id, action?: 'check_in' | 'start_journey', driver_lat?, driver_lng? }
 * Default action is check_in when omitted (safer than accidental activation).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  handleCORSPreflight,
  successResponse,
  errorResponse,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
} from "../_shared/security.ts";
import { haversineKm } from "../_shared/scheduledDispatchConfig.ts";

const RATE_LIMIT_CONFIG = { limit: 20, windowMs: 60_000, keyPrefix: "scheduled-checkin" };

/** Maximum distance from pickup for a valid check-in (metres). */
const MAX_CHECKIN_RADIUS_METRES = 300;

type ScheduledAction = "check_in" | "start_journey";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) return rateLimitResponse(rateLimitResult);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("UNAUTHORIZED", "Missing or invalid Authorization header", 401);
    }
    const token = authHeader.slice(7);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user) {
      return errorResponse("UNAUTHORIZED", "Invalid token", 401);
    }
    const userId = userData.user.id;

    const { data: driverRow, error: driverError } = await supabase
      .from("drivers")
      .select("id, first_name, last_name")
      .eq("user_id", userId)
      .single();

    if (driverError || !driverRow) {
      return errorResponse("FORBIDDEN", "Driver profile not found", 403);
    }
    const driverId = driverRow.id;

    let body: {
      trip_id: string;
      action?: string | null;
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

    const rawAction = typeof body.action === "string" ? body.action.trim().toLowerCase() : "check_in";
    const action: ScheduledAction =
      rawAction === "start_journey" || rawAction === "start-journey" || rawAction === "startjourney"
        ? "start_journey"
        : "check_in";

    const { data: policyRow } = await supabase
      .from("global_dispatch_settings")
      .select(
        "check_in_min_lead_minutes, check_in_grace_minutes, early_arrival_buffer_minutes, safety_buffer_minutes, pickup_access_allowance_minutes, start_journey_grace_minutes",
      )
      .eq("singleton", true)
      .maybeSingle();

    const checkInLead = Number(policyRow?.check_in_min_lead_minutes ?? 90);
    const checkInGrace = Number(policyRow?.check_in_grace_minutes ?? 15);
    const earlyArrival = Number(policyRow?.early_arrival_buffer_minutes ?? 10);
    const safety = Number(policyRow?.safety_buffer_minutes ?? 5);
    const access = Number(policyRow?.pickup_access_allowance_minutes ?? 0);
    const startGrace = Number(policyRow?.start_journey_grace_minutes ?? 5);

    const { data: trip, error: tripError } = await supabase
      .from("trips")
      .select(
        "id, status, scheduled_status, is_scheduled, dispatch_mode, driver_id, confirmed_driver_id, scheduled_at, pickup_latitude, pickup_longitude, passenger_id, pickup_address, scheduled_committed_at, driver_checked_in_at, driver_started_journey_to_pickup_at",
      )
      .eq("id", trip_id)
      .single();

    if (tripError || !trip) {
      return errorResponse("NOT_FOUND", "Trip not found", 404);
    }

    const TERMINAL_STATUSES = new Set([
      "completed", "cancelled", "customer_cancelled", "driver_cancelled",
      "no_show", "expired_no_driver", "expired",
    ]);
    if (TERMINAL_STATUSES.has(trip.status)) {
      return errorResponse("INVALID_STATE", `Trip is already ${trip.status}`, 409);
    }

    const isConfirmedDriver = trip.confirmed_driver_id === driverId;
    const isAssignedDriver = trip.driver_id === driverId;
    if (!isConfirmedDriver && !isAssignedDriver) {
      return errorResponse("FORBIDDEN", "You are not assigned to this trip", 403);
    }

    const ALLOWED_SCHEDULED = new Set([
      "scheduled_committed",
      "driver_assigned",
      "driver_en_route",
    ]);
    if (trip.scheduled_status && !ALLOWED_SCHEDULED.has(trip.scheduled_status)) {
      return errorResponse(
        "INVALID_STATE",
        `Cannot ${action === "check_in" ? "check in" : "start journey"} — trip is in state: ${trip.scheduled_status}`,
        409,
      );
    }

    const now = new Date();
    const nowMs = now.getTime();
    const pickupMs = Date.parse(trip.scheduled_at);
    if (!Number.isFinite(pickupMs)) {
      return errorResponse("INVALID_STATE", "Trip has no valid scheduled pickup time", 409);
    }

    const windowOpensMs = pickupMs - checkInLead * 60_000;
    const windowClosesMs = pickupMs + checkInGrace * 60_000;
    const leaveByMs = pickupMs - Math.max(earlyArrival + safety + access, 1) * 60_000;

    // Proximity: only when coords provided.
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
          `You must be within ${MAX_CHECKIN_RADIUS_METRES}m of the pickup. Current distance: ${Math.round(distanceMetres)}m.`,
          409,
        );
      }
    }

    // ── check_in: commitment readiness only ─────────────────────────────────
    if (action === "check_in") {
      if (trip.driver_id && trip.driver_id === driverId && trip.status === "en_route_to_pickup") {
        return successResponse({
          success: true,
          already_checked_in: true,
          activated: true,
          status: trip.status,
        });
      }
      if (trip.driver_checked_in_at) {
        return successResponse({
          success: true,
          already_checked_in: true,
          activated: false,
          leave_by_at: new Date(leaveByMs).toISOString(),
          status: "checked_in",
        });
      }
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

      const { error: updateError } = await supabase
        .from("trips")
        .update({
          driver_checked_in_at: now.toISOString(),
          updated_at: now.toISOString(),
        })
        .eq("id", trip_id)
        .eq("confirmed_driver_id", driverId)
        .is("driver_id", null);

      if (updateError) {
        console.error("[scheduled-checkin] check_in update failed:", updateError);
        return errorResponse("DATABASE_ERROR", updateError.message, 500);
      }

      console.log("SCHEDULED_CHECKIN_OK", {
        trip_id,
        driver_id: driverId,
        action: "check_in",
        activated: false,
      });

      return successResponse({
        success: true,
        checked_in: true,
        activated: false,
        leave_by_at: new Date(leaveByMs).toISOString(),
        status: "checked_in",
      });
    }

    // ── start_journey: activate and head to pickup ───────────────────────────
    if (trip.status === "en_route_to_pickup" || trip.scheduled_status === "driver_en_route") {
      return successResponse({
        success: true,
        already_started: true,
        activated: true,
        status: "en_route_to_pickup",
      });
    }

    if (!trip.driver_checked_in_at && nowMs < windowOpensMs) {
      return errorResponse(
        "CHECK_IN_REQUIRED",
        "Check in before starting the journey.",
        409,
      );
    }

    // Allow start once leave-by is reached, or within a small early buffer after check-in.
    if (nowMs + startGrace * 60_000 < leaveByMs && trip.driver_checked_in_at) {
      // Still before leave-by — allow early start after check-in (driver may leave early).
      // No hard block; UI surfaces leave-by as guidance.
    }

    const { error: activateError } = await supabase
      .from("trips")
      .update({
        driver_id: driverId,
        status: "en_route_to_pickup",
        scheduled_status: "driver_en_route",
        driver_started_journey_to_pickup_at: now.toISOString(),
        driver_checked_in_at: trip.driver_checked_in_at ?? now.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("id", trip_id)
      .or(`confirmed_driver_id.eq.${driverId},driver_id.eq.${driverId}`);

    if (activateError) {
      console.error("[scheduled-checkin] start_journey update failed:", activateError);
      return errorResponse("DATABASE_ERROR", activateError.message, 500);
    }

    console.log("SCHEDULED_START_JOURNEY_OK", {
      trip_id,
      driver_id: driverId,
      action: "start_journey",
      activated: true,
    });

    if (trip.passenger_id) {
      try {
        const driverName = driverRow.first_name?.trim() ?? "Your driver";
        await supabase.functions.invoke("send-customer-notification", {
          body: {
            passengerId: trip.passenger_id,
            type: "DRIVER_EN_ROUTE",
            title: "Your driver is on the way",
            body: `${driverName} is heading to your pickup at ${trip.pickup_address ?? "your location"}.`,
            data: {
              trip_id,
              type: "driver_en_route",
            },
          },
        });
      } catch (notifErr) {
        console.warn("[scheduled-checkin] Customer notification failed:", notifErr);
      }
    }

    return successResponse({
      success: true,
      activated: true,
      status: "en_route_to_pickup",
      trip_status: "en_route_to_pickup",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    console.error("[scheduled-checkin] Error:", err);
    return errorResponse("INTERNAL_ERROR", msg, 500);
  }
});
