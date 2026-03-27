import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  successResponse,
  errorResponse,
  logAuditEvent,
} from "../_shared/security.ts";

/**
 * driver-arrived
 *
 * Called when the driver taps "ARRIVED" at pickup.
 * Sets arrived_at, starts free waiting timer,
 * resets cancellation grace for post-arrival phase.
 */

const RATE_LIMIT_CONFIG = { limit: 30, windowMs: 60 * 1000 };

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const clientIP = getClientIP(req);
  const userAgent = req.headers.get("user-agent") || "unknown";

  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter!);

  try {
    let body: { trip_id: string; driver_id: string };
    try {
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON", 400);
    }

    const { trip_id, driver_id } = body;
    if (!trip_id || !driver_id) {
      return errorResponse("Missing trip_id or driver_id", 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Validate trip
    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select("id, status, driver_id, service_area_id, vehicle_type_id, arrived_at")
      .eq("id", trip_id)
      .single();

    if (tripErr || !trip) {
      return errorResponse("Trip not found", 404);
    }

    if (trip.driver_id !== driver_id) {
      return errorResponse("Trip does not belong to this driver", 403);
    }

    // Idempotency: already arrived
    if (trip.arrived_at) {
      return successResponse({
        already_arrived: true,
        arrived_at: trip.arrived_at,
        message: "Driver already marked as arrived",
      });
    }

    if (!["accepted", "en_route"].includes(trip.status)) {
      return errorResponse(`Cannot mark arrived from status: ${trip.status}`, 400);
    }

    // Fetch fare pricing settings for free waiting + cancellation grace
    let freeWaitingMinutes = 3;
    let gracePeriodMinutes = 3;
    let waitingPerMinutePence = 0;
    let enableWaitingCharge = false;
    let noShowWaitTimeMinutes = 5;

    if (trip.service_area_id) {
      const fpsQuery = supabase
        .from("fare_pricing_settings")
        .select(
          "free_waiting_minutes, cancellation_grace_period_minutes, waiting_per_minute_pence, recalculate_on_waiting, no_show_wait_time_minutes"
        )
        .eq("service_area_id", trip.service_area_id);

      if (trip.vehicle_type_id) {
        fpsQuery.eq("vehicle_type_id", trip.vehicle_type_id);
      }

      const { data: fps } = await fpsQuery.maybeSingle();
      if (fps) {
        freeWaitingMinutes = fps.free_waiting_minutes ?? 3;
        gracePeriodMinutes = fps.cancellation_grace_period_minutes ?? 3;
        waitingPerMinutePence = fps.waiting_per_minute_pence ?? 0;
        enableWaitingCharge = fps.recalculate_on_waiting ?? false;
        noShowWaitTimeMinutes = fps.no_show_wait_time_minutes ?? 5;
      }
    }

    const now = new Date();
    const freeWaitExpiresAt = new Date(now.getTime() + freeWaitingMinutes * 60 * 1000);
    const arrivalGraceExpiresAt = new Date(now.getTime() + gracePeriodMinutes * 60 * 1000);

    // Update trip
    const { error: updateErr } = await supabase
      .from("trips")
      .update({
        status: "arrived",
        arrived_at: now.toISOString(),
        free_wait_expires_at: freeWaitExpiresAt.toISOString(),
        cancellation_grace_expires_at: arrivalGraceExpiresAt.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("id", trip_id);

    if (updateErr) {
      console.error("[driver-arrived] update error:", updateErr);
      return errorResponse("Failed to update trip", 500);
    }

    await logAuditEvent(supabase, "driver_arrived", {
      driverId: driver_id,
      tripId: trip_id,
      details: {
        free_waiting_minutes: freeWaitingMinutes,
        grace_period_minutes: gracePeriodMinutes,
        waiting_per_minute_pence: waitingPerMinutePence,
        no_show_wait_time_minutes: noShowWaitTimeMinutes,
      },
      ipAddress: clientIP,
      userAgent,
    });

    console.log(
      `[driver-arrived] Trip ${trip_id}: arrived, free wait ${freeWaitingMinutes}min, grace ${gracePeriodMinutes}min`
    );

    return successResponse({
      trip_id,
      arrived_at: now.toISOString(),
      free_wait_expires_at: freeWaitExpiresAt.toISOString(),
      cancellation_grace_expires_at: arrivalGraceExpiresAt.toISOString(),
      free_waiting_minutes: freeWaitingMinutes,
      waiting_per_minute_pence: waitingPerMinutePence,
      enable_waiting_charge: enableWaitingCharge,
      no_show_wait_time_minutes: noShowWaitTimeMinutes,
      // Messages for driver app
      driver_message: "Free waiting started",
      rider_message: `Driver has arrived. ${freeWaitingMinutes} minutes free waiting`,
    });
  } catch (err) {
    console.error("[driver-arrived] Error:", err);
    return errorResponse(err instanceof Error ? err.message : "Unknown error", 500);
  }
});
