import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  handleCORSPreflight,
  successResponse,
  errorResponse,
  isValidUUID,
  validationErrorResponse,
} from "../_shared/security.ts";
import { loadAdminWaitingConfig } from "../_shared/waitingAdminConfig.ts";
import {
  computeStopChargeFromCountedSeconds,
  resolveEffectiveWaitingRadiusMeters,
  syncWaitingGeofenceClock,
} from "../_shared/waitingSegmentClock.ts";

const RATE_LIMIT_CONFIG = {
  limit: 120,
  windowMs: 60000,
  keyPrefix: "tick-waiting-charge",
};

async function writeTripAudit(
  supabase: ReturnType<typeof createClient>,
  row: {
    trip_id: string;
    driver_id: string;
    event_type: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await supabase.from("audit_logs").insert({
      trip_id: row.trip_id,
      driver_id: row.driver_id,
      event_type: row.event_type,
      details: row.details ?? {},
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("[tick-waiting-charge] audit_logs insert failed:", row.event_type, e);
  }
}

/**
 * TICK WAITING CHARGE — Stop waiting from counted in-radius segments only.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return errorResponse("UNAUTHORIZED", "Authentication required", 401);

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { data: authData, error: authErr } = await authClient.auth.getUser(token);
    if (authErr || !authData?.user) return errorResponse("UNAUTHORIZED", "Invalid token", 401);

    const { data: driver } = await supabase
      .from("drivers")
      .select("id")
      .eq("user_id", authData.user.id)
      .single();
    if (!driver) return errorResponse("FORBIDDEN", "Driver not found", 403);

    const body = await req.json();
    const { trip_id, stop_id, driver_lat, driver_lng } = body;

    const errors: Record<string, string> = {};
    if (!trip_id || !isValidUUID(trip_id)) errors.trip_id = "Valid trip_id required";
    if (!stop_id || !isValidUUID(stop_id)) errors.stop_id = "Valid stop_id required";
    if (Object.keys(errors).length > 0) return validationErrorResponse(errors);

    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select(
        "id, driver_id, confirmed_driver_id, service_area_id, stop_waiting_paid_started_at, stop_waiting_status, stop_waiting_counted_seconds, waiting_geofence_status",
      )
      .eq("id", trip_id)
      .single();

    if (tripErr || !trip) return errorResponse("NOT_FOUND", "Trip not found", 404);
    if (trip.driver_id !== driver.id && trip.confirmed_driver_id !== driver.id) {
      return errorResponse("FORBIDDEN", "Not your trip", 403);
    }

    const config = await loadAdminWaitingConfig(supabase, trip.service_area_id ?? null);
    if (config.enable_stop_waiting_charge === false) {
      return successResponse({
        success: true,
        no_op: true,
        message: "Stop waiting charge disabled by admin",
      });
    }

    const { data: stop, error: stopErr } = await supabase
      .from("trip_stops")
      .select(
        "id, trip_id, type, stop_index, lat, lng, arrived_at, waiting_charge_active, waiting_started_at, waiting_total_amount_pence, waiting_total_seconds",
      )
      .eq("id", stop_id)
      .single();

    if (stopErr || !stop) return errorResponse("NOT_FOUND", "Stop not found", 404);
    if (stop.trip_id !== trip_id) return errorResponse("BAD_REQUEST", "Stop does not belong to trip", 400);
    if (!stop.arrived_at) {
      return errorResponse("MUST_ARRIVE_AT_STOP", "Stop waiting requires Arrive at Stop first", 409);
    }
    if (!stop.waiting_charge_active || !stop.waiting_started_at) {
      return successResponse({ success: true, no_op: true, message: "Waiting charge not active" });
    }

    const gracePeriod = config.free_stop_waiting_seconds;
    const ratePPM = config.stop_waiting_rate_pence_per_minute;
    const maxMinutes = config.stop_waiting_max_minutes;
    const previousPence = stop.waiting_total_amount_pence || 0;
    const driverId = driver.id;
    const nowIso = new Date().toISOString();

    let countedSeconds = Number(trip.stop_waiting_counted_seconds ?? 0);
    let geofenceStatus = trip.waiting_geofence_status ?? "paused";

    if (stop.lat != null && stop.lng != null) {
      const clock = await syncWaitingGeofenceClock(supabase, {
        tripId: trip_id,
        driverId,
        locationType: "stop",
        stopId: stop.id,
        stopIndex: stop.stop_index ?? null,
        target: {
          lat: stop.lat,
          lng: stop.lng,
          radiusMeters: resolveEffectiveWaitingRadiusMeters(
            config.stop_radius_meters,
            config.stop_radius_enabled,
          ),
          radiusEnabled: config.stop_radius_enabled,
        },
        bodyLat: typeof driver_lat === "number" ? driver_lat : null,
        bodyLng: typeof driver_lng === "number" ? driver_lng : null,
        nowIso,
      });
      countedSeconds = clock.countedSeconds;
      geofenceStatus = clock.status;
      console.log("STOP_WAITING_GEOFENCE_TICK", {
        trip_id,
        stop_id,
        status: clock.status,
        counted_seconds: clock.countedSeconds,
        used_source: clock.usedSource,
        trusted_overrides_body: clock.trustedOverridesBody,
      });
    }

    const wallElapsed = Math.max(
      0,
      Math.floor((Date.now() - new Date(stop.arrived_at).getTime()) / 1000),
    );

    if (countedSeconds >= gracePeriod && !trip.stop_waiting_paid_started_at) {
      await supabase
        .from("trips")
        .update({
          stop_waiting_paid_started_at: nowIso,
          stop_waiting_status: "paid_waiting",
        })
        .eq("id", trip_id);

      await writeTripAudit(supabase, {
        trip_id,
        driver_id: driverId,
        event_type: "STOP_FREE_WAITING_EXPIRED",
        details: {
          stop_id,
          grace_seconds: gracePeriod,
          counted_seconds: countedSeconds,
        },
      });
    }

    const charged = computeStopChargeFromCountedSeconds({
      countedSeconds,
      freeWaitSeconds: gracePeriod,
      ratePencePerMinute: ratePPM,
      maxMinutes,
    });
    const totalPence = charged.charge_pence;
    const chargeableSeconds = charged.paid_seconds;
    const capped =
      maxMinutes != null &&
      maxMinutes > 0 &&
      chargeableSeconds >= Math.round(maxMinutes) * 60;

    await supabase
      .from("trip_stops")
      .update({
        waiting_charge_active: capped ? false : true,
        waiting_total_amount_pence: totalPence,
        waiting_total_seconds: countedSeconds,
        waiting_stopped_at: capped ? nowIso : null,
        last_waiting_charge_update_at: nowIso,
      })
      .eq("id", stop_id);

    await updateTripTotalWaiting(supabase, trip_id, totalPence);

    if (totalPence > previousPence) {
      await writeTripAudit(supabase, {
        trip_id,
        driver_id: driverId,
        event_type: "STOP_WAITING_CHARGE_APPLIED",
        details: {
          stop_id,
          charge_pence: totalPence,
          delta_pence: totalPence - previousPence,
          counted_seconds: countedSeconds,
          chargeable_seconds: chargeableSeconds,
          capped,
        },
      });
    }

    return successResponse({
      success: true,
      capped,
      elapsed_seconds: wallElapsed,
      counted_in_radius_seconds: countedSeconds,
      chargeable_seconds: chargeableSeconds,
      total_amount_pence: totalPence,
      rate_pence_per_minute: ratePPM,
      in_free_period: countedSeconds < gracePeriod,
      stop_arrived_at: stop.arrived_at ?? null,
      waiting_geofence_status: geofenceStatus,
      admin_waiting_config_snapshot: config,
    });
  } catch (err) {
    console.error("[tick-waiting-charge] Error:", err);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});

async function updateTripTotalWaiting(
  supabase: ReturnType<typeof createClient>,
  tripId: string,
  liveStopPence?: number,
) {
  const { data: allStops } = await supabase
    .from("trip_stops")
    .select("waiting_total_amount_pence")
    .eq("trip_id", tripId);

  const total = (allStops ?? []).reduce(
    (sum: number, s: { waiting_total_amount_pence?: number | null }) =>
      sum + (s.waiting_total_amount_pence || 0),
    0,
  );

  const tripUpdate: Record<string, unknown> = {
    total_waiting_charge_pence: total,
    stop_waiting_charge_pence: total,
    stop_charge_total_pence: total,
  };
  if (typeof liveStopPence === "number") {
    tripUpdate.stop_waiting_charge_amount = liveStopPence;
  }

  await supabase.from("trips").update(tripUpdate).eq("id", tripId);
}
