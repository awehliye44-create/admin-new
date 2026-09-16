import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireAuthenticatedUser } from "../_shared/edgeAuth.ts";
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
import { isTripAtPickupStatus, resolveDriverArrivedAtIso } from "../_shared/pickupWaiting.ts";
import {
  loadAdminWaitingConfig,
  resolveFrozenOrLiveWaitingConfig,
} from "../_shared/waitingAdminConfig.ts";
import { computeLiveTripFarePreview } from "../_shared/liveTripFareSSOT.ts";
import {
  computePickupChargeFromCountedSeconds,
  resolveEffectiveWaitingRadiusMeters,
  syncWaitingGeofenceClock,
} from "../_shared/waitingSegmentClock.ts";

const RATE_LIMIT_CONFIG = {
  limit: 120,
  windowMs: 60000,
  keyPrefix: "tick-pickup-waiting",
};

/**
 * TICK PICKUP WAITING CHARGE — Server-authoritative pickup waiting fee.
 *
 * Charge from counted in-radius segment seconds only (trusted GPS).
 * Wall-time from pickup_waiting_started_at is UI/session only.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !serviceRoleKey || !anonKey) {
      console.error("[tick-pickup-waiting-charge] Missing env vars");
      return errorResponse("INTERNAL_ERROR", "Server configuration error", 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const auth = await requireAuthenticatedUser(req, supabaseUrl, anonKey);
    if (!auth.ok) {
      return auth.response;
    }
    const userId = auth.userId;

    const { data: driver } = await supabase
      .from("drivers")
      .select("id")
      .eq("user_id", userId)
      .single();
    if (!driver) return errorResponse("FORBIDDEN", "Driver not found", 403);

    const body = await req.json();
    const { trip_id, driver_lat, driver_lng } = body;
    if (!trip_id || !isValidUUID(trip_id)) {
      return validationErrorResponse({ trip_id: "Valid trip_id required" });
    }

    const tripSelectCols =
      "id, driver_id, confirmed_driver_id, status, arrived_at, pickup_arrived_at, pickup_waiting_started_at, service_area_id, vehicle_type_id, pickup_latitude, pickup_longitude, pickup_waiting_charge_pence, pickup_paid_waiting_started_at, grace_period_expired_at, no_show_charge_pence, late_cancel_fee_pence, pickup_waiting_admin_config, pickup_waiting_finalized_at, pickup_waiting_intervals_charged, free_wait_expires_at, final_customer_fare_pence, final_fare_pence, locked_base_fare_pence, stop_waiting_charge_pence, stop_charge_total_pence, customer_modification_charge_pence, modification_delta_pence, accepted_commission_percent, driver_tier_commission_percent, commission_pct, commission_pence, gross_fare_pence, offer_discount_pence, discount_pence, pickup_waiting_counted_seconds, waiting_geofence_status";

    const liveFareFields = (row: Record<string, unknown>, pickupChargeOverride?: number) => {
      const preview = computeLiveTripFarePreview({
        final_customer_fare_pence: row.final_customer_fare_pence as number | null,
        final_fare_pence: row.final_fare_pence as number | null,
        locked_base_fare_pence: row.locked_base_fare_pence as number | null,
        pickup_waiting_charge_pence:
          pickupChargeOverride ?? (row.pickup_waiting_charge_pence as number | null),
        stop_waiting_charge_pence: row.stop_waiting_charge_pence as number | null,
        stop_charge_total_pence: row.stop_charge_total_pence as number | null,
        customer_modification_charge_pence: row.customer_modification_charge_pence as number | null,
        modification_delta_pence: row.modification_delta_pence as number | null,
        accepted_commission_percent: row.accepted_commission_percent as number | null,
        driver_tier_commission_percent: row.driver_tier_commission_percent as number | null,
        commission_pct: row.commission_pct as number | null,
        commission_pence: row.commission_pence as number | null,
        gross_fare_pence: row.gross_fare_pence as number | null,
        offer_discount_pence: row.offer_discount_pence as number | null,
        discount_pence: row.discount_pence as number | null,
      });
      return {
        final_customer_fare_pence: preview.final_customer_fare_pence,
        pickup_waiting_charge_pence: preview.pickup_waiting_charge_pence,
        stop_waiting_charge_pence: preview.stop_waiting_charge_pence,
        approved_modification_delta_pence: preview.approved_modification_delta_pence,
        current_customer_total_pence: preview.current_customer_total_pence,
        driver_net_preview_pence: preview.driver_net_preview_pence,
        commission_percent: preview.commission_percent,
      };
    };

    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select(tripSelectCols)
      .eq("id", trip_id)
      .single();

    if (tripErr || !trip) return errorResponse("NOT_FOUND", "Trip not found", 404);

    if (trip.driver_id !== driver.id && trip.confirmed_driver_id !== driver.id) {
      return errorResponse("FORBIDDEN", "Not your trip", 403);
    }

    if ((trip.no_show_charge_pence ?? 0) > 0 || (trip.late_cancel_fee_pence ?? 0) > 0) {
      return successResponse({
        success: true,
        no_op: true,
        reason: "Higher-priority charge already applied",
        pickup_waiting_charge_pence: 0,
        ...liveFareFields(trip as Record<string, unknown>, 0),
      });
    }

    if (trip.pickup_waiting_finalized_at || !isTripAtPickupStatus(trip.status)) {
      return successResponse({
        success: true,
        no_op: true,
        message: trip.pickup_waiting_finalized_at
          ? "Pickup waiting finalized"
          : "Trip not at pickup",
        pickup_waiting_charge_pence: trip.pickup_waiting_charge_pence ?? 0,
        pickup_waiting_intervals_charged: trip.pickup_waiting_intervals_charged ?? 0,
        pickup_waiting_finalized_at: trip.pickup_waiting_finalized_at ?? null,
        waiting_geofence_status: trip.waiting_geofence_status ?? null,
        ...liveFareFields(trip as Record<string, unknown>),
      });
    }

    const pickupArrivedAt = await resolveDriverArrivedAtIso(supabase, trip_id, trip);
    if (!pickupArrivedAt) {
      return successResponse({ success: true, no_op: true, message: "No arrival time recorded" });
    }

    const pickupWaitingStartedAt =
      typeof trip.pickup_waiting_started_at === "string" && trip.pickup_waiting_started_at.trim()
        ? trip.pickup_waiting_started_at
        : null;
    if (!pickupWaitingStartedAt) {
      return successResponse({
        success: true,
        no_op: true,
        message: "Pickup waiting has not started",
        pickup_arrived_at: pickupArrivedAt,
        elapsed_seconds: 0,
        grace_expired: false,
        grace_remaining_seconds: null,
        paid_waiting_active: false,
        pickup_waiting_charge_pence: 0,
        waiting_geofence_status: "not_started",
        ...liveFareFields(trip as Record<string, unknown>, 0),
      });
    }

    const liveConfig = await loadAdminWaitingConfig(
      supabase,
      trip.service_area_id ?? null,
      trip.vehicle_type_id ?? null,
    );
    const config = resolveFrozenOrLiveWaitingConfig(trip.pickup_waiting_admin_config, liveConfig);

    if (!trip.pickup_waiting_admin_config) {
      await supabase
        .from("trips")
        .update({ pickup_waiting_admin_config: config })
        .eq("id", trip_id);
    }

    if (!config.config_available) {
      return successResponse({
        success: true,
        no_op: true,
        waiting_config_unavailable: true,
        message: "Waiting config unavailable — fail closed (no invented charge)",
        pickup_waiting_charge_pence: trip.pickup_waiting_charge_pence ?? 0,
        ...liveFareFields(trip as Record<string, unknown>),
      });
    }

    const gracePeriodSeconds = config.free_pickup_waiting_seconds;
    const paidWaitingEnabled = config.pickup_paid_waiting_enabled;
    const ratePPM = config.pickup_paid_waiting_rate_pence_per_minute;
    const maxMinutes = config.pickup_waiting_max_minutes;
    const intervalSeconds = config.waiting_charge_interval_seconds;

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const waitingStartMs = new Date(pickupWaitingStartedAt).getTime();
    const wallElapsedSeconds = Math.max(0, Math.floor((nowMs - waitingStartMs) / 1000));
    const freeWaitExpiresAt =
      trip.free_wait_expires_at ??
      new Date(waitingStartMs + gracePeriodSeconds * 1000).toISOString();

    let geofenceStatus = trip.waiting_geofence_status ?? "paused";
    let countedSeconds = Number(trip.pickup_waiting_counted_seconds ?? 0);

    if (trip.pickup_latitude != null && trip.pickup_longitude != null) {
      const clock = await syncWaitingGeofenceClock(supabase, {
        tripId: trip_id,
        driverId: driver.id,
        locationType: "pickup",
        target: {
          lat: trip.pickup_latitude,
          lng: trip.pickup_longitude,
          radiusMeters: resolveEffectiveWaitingRadiusMeters(
            config.pickup_radius_meters,
            config.pickup_radius_enabled,
          ),
          radiusEnabled: config.pickup_radius_enabled,
        },
        bodyLat: typeof driver_lat === "number" ? driver_lat : null,
        bodyLng: typeof driver_lng === "number" ? driver_lng : null,
        nowIso,
      });
      geofenceStatus = clock.status;
      countedSeconds = clock.countedSeconds;
      console.log("PICKUP_WAITING_GEOFENCE_TICK", {
        trip_id,
        status: clock.status,
        counted_seconds: clock.countedSeconds,
        used_source: clock.usedSource,
        trusted_overrides_body: clock.trustedOverridesBody,
        distance_meters: clock.distanceMeters,
      });
    }

    // Free-wait / paid gate uses counted in-radius seconds (not wall elapsed).
    const graceExpired = countedSeconds >= gracePeriodSeconds;
    const graceRemainingSeconds = Math.max(0, gracePeriodSeconds - countedSeconds);

    if (!graceExpired || !paidWaitingEnabled) {
      return successResponse({
        success: true,
        elapsed_seconds: wallElapsedSeconds,
        counted_in_radius_seconds: countedSeconds,
        grace_expired: graceExpired,
        grace_remaining_seconds: graceRemainingSeconds,
        free_wait_expires_at: freeWaitExpiresAt,
        paid_waiting_enabled: paidWaitingEnabled,
        paid_waiting_active: false,
        pickup_waiting_charge_pence: 0,
        intervals_charged: 0,
        charge_interval_seconds: intervalSeconds,
        rate_pence_per_minute: ratePPM,
        pickup_arrived_at: pickupArrivedAt,
        pickup_waiting_started_at: pickupWaitingStartedAt,
        waiting_geofence_status: geofenceStatus,
        admin_waiting_config_snapshot: config,
        ...liveFareFields(trip as Record<string, unknown>, 0),
      });
    }

    if (intervalSeconds <= 0 || ratePPM <= 0) {
      return successResponse({
        success: true,
        no_op: true,
        waiting_config_unavailable: true,
        message: "Charge interval or rate unavailable — fail closed",
        elapsed_seconds: wallElapsedSeconds,
        counted_in_radius_seconds: countedSeconds,
        grace_expired: true,
        paid_waiting_enabled: true,
        pickup_waiting_charge_pence: trip.pickup_waiting_charge_pence ?? 0,
        waiting_geofence_status: geofenceStatus,
        admin_waiting_config_snapshot: config,
        ...liveFareFields(trip as Record<string, unknown>),
      });
    }

    const charged = computePickupChargeFromCountedSeconds({
      countedSeconds,
      freeWaitSeconds: gracePeriodSeconds,
      ratePencePerMinute: ratePPM,
      intervalSeconds,
      maxMinutes,
    });

    const prevIntervals = Number(trip.pickup_waiting_intervals_charged ?? 0);
    const prevCharge = Number(trip.pickup_waiting_charge_pence ?? 0);
    const nextChargeAt = new Date(
      nowMs + charged.interval_seconds * 1000,
    ).toISOString();

    if (charged.intervals_charged === prevIntervals && charged.charge_pence === prevCharge) {
      return successResponse({
        success: true,
        idempotent: true,
        elapsed_seconds: wallElapsedSeconds,
        counted_in_radius_seconds: countedSeconds,
        grace_expired: true,
        grace_remaining_seconds: 0,
        free_wait_expires_at: freeWaitExpiresAt,
        paid_waiting_enabled: true,
        paid_waiting_active: charged.intervals_charged > 0,
        paid_seconds: charged.paid_seconds_capped,
        intervals_charged: charged.intervals_charged,
        charge_interval_seconds: charged.interval_seconds,
        pence_per_interval: charged.pence_per_interval,
        next_charge_at: nextChargeAt,
        pickup_waiting_charge_pence: charged.charge_pence,
        rate_pence_per_minute: ratePPM,
        waiting_charge_rounding: "completed_intervals",
        pickup_arrived_at: pickupArrivedAt,
        pickup_waiting_started_at: pickupWaitingStartedAt,
        waiting_geofence_status: geofenceStatus,
        admin_waiting_config_snapshot: config,
        ...liveFareFields(trip as Record<string, unknown>, charged.charge_pence),
      });
    }

    const updateData: Record<string, unknown> = {
      pickup_waiting_charge_pence: charged.charge_pence,
      pickup_waiting_intervals_charged: charged.intervals_charged,
      pickup_waiting_chargeable_seconds: charged.paid_seconds_capped,
      pickup_waiting_counted_seconds: countedSeconds,
      pickup_waiting_last_tick_at: nowIso,
    };
    if (!trip.grace_period_expired_at) updateData.grace_period_expired_at = nowIso;
    if (!trip.pickup_paid_waiting_started_at && charged.charge_pence > 0) {
      updateData.pickup_paid_waiting_started_at = nowIso;
    }

    await supabase.from("trips").update(updateData).eq("id", trip_id);

    return successResponse({
      success: true,
      elapsed_seconds: wallElapsedSeconds,
      counted_in_radius_seconds: countedSeconds,
      grace_expired: true,
      grace_remaining_seconds: 0,
      free_wait_expires_at: freeWaitExpiresAt,
      paid_waiting_enabled: true,
      paid_waiting_active: true,
      paid_seconds: charged.paid_seconds_capped,
      intervals_charged: charged.intervals_charged,
      charge_interval_seconds: charged.interval_seconds,
      pence_per_interval: charged.pence_per_interval,
      last_charge_tick_at: nowIso,
      next_charge_at: nextChargeAt,
      capped: charged.paid_seconds_capped >= maxMinutes * 60,
      max_minutes: maxMinutes,
      pickup_waiting_charge_pence: charged.charge_pence,
      rate_pence_per_minute: ratePPM,
      waiting_charge_rounding: "completed_intervals",
      pickup_arrived_at: pickupArrivedAt,
      pickup_waiting_started_at: pickupWaitingStartedAt,
      waiting_geofence_status: geofenceStatus,
      admin_waiting_config_snapshot: config,
      ...liveFareFields(trip as Record<string, unknown>, charged.charge_pence),
    });
  } catch (err) {
    console.error("[tick-pickup-waiting-charge] Error:", err);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
