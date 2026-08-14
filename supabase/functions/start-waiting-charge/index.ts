import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  securityHeaders,
  jsonHeaders,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  handleCORSPreflight,
  successResponse,
  errorResponse,
  isValidUUID,
  validationErrorResponse,
} from "../_shared/security.ts";

const RATE_LIMIT_CONFIG = {
  limit: 30,
  windowMs: 60000,
  keyPrefix: 'start-waiting-charge',
};

/** Weak GPS threshold in meters */
const WEAK_GPS_ACCURACY_METERS = 50;

/**
 * START WAITING CHARGE — Server-side validation
 *
 * Validates driver GPS position against the current stop's lat/lng
 * using the admin-configured stop_radius_meters before allowing
 * the waiting charge timer to start.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  console.warn(
    "[start-waiting-charge] LEGACY_PATH_EXECUTED — stop waiting starts on stop-workflow arrive_stop",
  );

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // ── Auth ──
    const authHeader = req.headers.get("Authorization");
    let driverId: string;

    if (authHeader) {
      const authClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const token = authHeader.replace("Bearer ", "");
      const { data, error: authErr } = await authClient.auth.getUser(token);
      if (authErr || !data?.user) {
        return errorResponse("UNAUTHORIZED", "Invalid or expired token", 401);
      }
      const { data: driver } = await supabase
        .from("drivers")
        .select("id")
        .eq("user_id", data.user.id)
        .single();
      if (!driver) return errorResponse("FORBIDDEN", "Driver not found", 403);
      driverId = driver.id;
    } else {
      return errorResponse("UNAUTHORIZED", "Authentication required", 401);
    }

    // ── Input ──
    const body = await req.json();
    const { trip_id, stop_id, driver_lat, driver_lng, gps_accuracy } = body;

    const errors: Record<string, string> = {};
    if (!trip_id || !isValidUUID(trip_id)) errors.trip_id = "Valid trip_id required";
    if (!stop_id || !isValidUUID(stop_id)) errors.stop_id = "Valid stop_id required";
    if (driver_lat == null || typeof driver_lat !== "number") errors.driver_lat = "driver_lat required";
    if (driver_lng == null || typeof driver_lng !== "number") errors.driver_lng = "driver_lng required";
    if (Object.keys(errors).length > 0) return validationErrorResponse(errors);

    // ── Verify trip ownership ──
    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select("id, driver_id, confirmed_driver_id, service_area_id, status")
      .eq("id", trip_id)
      .single();

    if (tripErr || !trip) return errorResponse("NOT_FOUND", "Trip not found", 404);
    if (trip.driver_id !== driverId && trip.confirmed_driver_id !== driverId) {
      return errorResponse("FORBIDDEN", "Not your trip", 403);
    }

    // ── Verify stop belongs to trip and is current ──
    const { data: stop, error: stopErr } = await supabase
      .from("trip_stops")
      .select("id, trip_id, stop_index, type, status, lat, lng, arrived_at, waiting_charge_active, waiting_started_at")
      .eq("id", stop_id)
      .single();

    if (stopErr || !stop) return errorResponse("NOT_FOUND", "Stop not found", 404);
    if (stop.trip_id !== trip_id) return errorResponse("BAD_REQUEST", "Stop does not belong to trip", 400);
    if (stop.type !== "stop") return errorResponse("BAD_REQUEST", "Only intermediate stops support waiting charges", 400);
    if (stop.status !== "current" && stop.status !== "pending") {
      return errorResponse("BAD_REQUEST", "Stop is not active", 400);
    }
    if (!stop.arrived_at) {
      return errorResponse(
        "MUST_ARRIVE_AT_STOP",
        "Tap Arrive at Stop before stop waiting can start",
        409,
      );
    }

    // Idempotency: already charging
    if (stop.waiting_charge_active) {
      return successResponse({ success: true, idempotent: true, message: "Already charging" });
    }

    // ── GPS accuracy check ──
    if (gps_accuracy != null && typeof gps_accuracy === "number" && gps_accuracy > WEAK_GPS_ACCURACY_METERS) {
      console.warn("[start-waiting-charge] Weak GPS:", gps_accuracy);
      return errorResponse("WEAK_GPS_SIGNAL", `GPS accuracy is ${Math.round(gps_accuracy)}m. Must be under ${WEAK_GPS_ACCURACY_METERS}m.`, 400);
    }

    // ── Fetch radius settings (service-area → global fallback) ──
    const selectCols = "enable_stop_waiting_charge, stop_radius_enabled, stop_radius_meters, stop_waiting_charge_interval_seconds, stop_waiting_grace_period_seconds, stop_waiting_rate_pence_per_minute";
    let settings: any = null;

    if (trip.service_area_id) {
      const { data } = await supabase
        .from("dispatch_settings")
        .select(selectCols)
        .eq("service_area_id", trip.service_area_id)
        .maybeSingle();
      if (data) settings = data;
    }
    if (!settings) {
      const { data } = await supabase
        .from("dispatch_settings")
        .select(selectCols)
        .is("service_area_id", null)
        .maybeSingle();
      if (data) settings = data;
    }
    if (!settings) {
      const { data } = await supabase
        .from("dispatch_settings")
        .select(selectCols)
        .limit(1)
        .maybeSingle();
      if (data) settings = data;
    }

    const radiusEnabled = settings?.stop_radius_enabled ?? false;
    const radiusMeters = settings?.stop_radius_meters ?? 50;
    const chargeInterval = settings?.stop_waiting_charge_interval_seconds ?? 10;
    const gracePeriod = settings?.stop_waiting_grace_period_seconds ?? 60;
    const ratePPM = settings?.stop_waiting_rate_pence_per_minute ?? 60;

    if (settings?.enable_stop_waiting_charge === false) {
      return errorResponse(
        "STOP_WAITING_DISABLED",
        "Stop waiting charges are disabled for this service area",
        403,
      );
    }

    // ── Radius enforcement ──
    if (radiusEnabled && stop.lat != null && stop.lng != null) {
      const distance = haversineMeters(driver_lat, driver_lng, stop.lat, stop.lng);
      console.log("[start-waiting-charge] Distance check:", { distance, radiusMeters, stopLat: stop.lat, stopLng: stop.lng });

      if (distance > radiusMeters) {
        return errorResponse(
          "GET_PAID_OUTSIDE_RADIUS",
          `You must be within ${radiusMeters}m of the stop. Currently ${Math.round(distance)}m away.`,
          400
        );
      }
    }

    // ── Approved — persist to DB ──
    const now = new Date().toISOString();
    await supabase
      .from("trip_stops")
      .update({
        waiting_charge_active: true,
        waiting_started_at: now,
        waiting_stopped_at: null,
        waiting_total_amount_pence: 0,
        waiting_total_seconds: 0,
        last_waiting_charge_update_at: now,
      })
      .eq("id", stop_id);

    console.log("[start-waiting-charge] Approved for stop:", stop_id, "trip:", trip_id);

    return successResponse({
      success: true,
      stop_id,
      started_at: now,
      charge_interval_seconds: chargeInterval,
      grace_period_seconds: gracePeriod,
      rate_pence_per_minute: ratePPM,
    });
  } catch (err) {
    console.error("[start-waiting-charge] Error:", err);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});

/** Haversine distance in meters */
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
