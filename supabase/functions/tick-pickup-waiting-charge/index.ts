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
  computePickupWaitingChargePence,
  loadAdminWaitingConfig,
  resolveFrozenOrLiveWaitingConfig,
} from "../_shared/waitingAdminConfig.ts";
import { computeLiveTripFarePreview } from "../_shared/liveTripFareSSOT.ts";

const RATE_LIMIT_CONFIG = {
  limit: 120,
  windowMs: 60000,
  keyPrefix: "tick-pickup-waiting",
};

/**
 * TICK PICKUP WAITING CHARGE — Server-authoritative pickup waiting fee.
 *
 * Anchors to pickup_waiting_started_at only.
 * Uses frozen trip.pickup_waiting_admin_config when present.
 * Rounding: completed intervals only (not continuous prorate).
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
      "id, driver_id, confirmed_driver_id, status, arrived_at, pickup_arrived_at, pickup_waiting_started_at, service_area_id, vehicle_type_id, pickup_latitude, pickup_longitude, pickup_waiting_charge_pence, pickup_paid_waiting_started_at, grace_period_expired_at, no_show_charge_pence, late_cancel_fee_pence, pickup_waiting_admin_config, pickup_waiting_finalized_at, pickup_waiting_intervals_charged, free_wait_expires_at, final_customer_fare_pence, final_fare_pence, locked_base_fare_pence, stop_waiting_charge_pence, stop_charge_total_pence, customer_modification_charge_pence, modification_delta_pence, accepted_commission_percent, driver_tier_commission_percent, commission_pct, commission_pence, gross_fare_pence";

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

    console.log("PICKUP_WAITING_SELECT_PROD_SAFE", { trip_id, select_cols: tripSelectCols });
    console.log("DRIVER_ARRIVED_AT_COLUMN_REMOVED_FROM_SELECTS", {
      function: "tick-pickup-waiting-charge",
      canonical_arrival_fields: ["pickup_arrived_at", "arrived_at"],
    });
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
        ...liveFareFields(trip as Record<string, unknown>),
      });
    }

    const pickupArrivedAt = await resolveDriverArrivedAtIso(supabase, trip_id, trip);
    console.log("PICKUP_ARRIVAL_TIMESTAMP_LOADED", {
      trip_id,
      pickup_arrived_at: pickupArrivedAt,
      trip_pickup_arrived_at: trip.pickup_arrived_at ?? null,
      trip_arrived_at: trip.arrived_at ?? null,
      pickup_waiting_started_at: trip.pickup_waiting_started_at ?? null,
    });
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
      const { error: cfgErr } = await supabase
        .from("trips")
        .update({ pickup_waiting_admin_config: config })
        .eq("id", trip_id);
      if (cfgErr) {
        console.warn("[tick-pickup-waiting-charge] PICKUP_WAITING_ADMIN_CONFIG_BACKFILL_FAILED", {
          trip_id,
          message: cfgErr.message,
        });
      }
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
    const radiusEnabled = config.pickup_radius_enabled;
    const radiusMeters = config.pickup_radius_meters;

    const waitingStartMs = new Date(pickupWaitingStartedAt).getTime();
    const nowMs = Date.now();
    const elapsedSeconds = Math.max(0, Math.floor((nowMs - waitingStartMs) / 1000));
    const graceExpired = elapsedSeconds >= gracePeriodSeconds;
    const graceRemainingSeconds = Math.max(0, gracePeriodSeconds - elapsedSeconds);
    const freeWaitExpiresAt =
      trip.free_wait_expires_at ??
      new Date(waitingStartMs + gracePeriodSeconds * 1000).toISOString();

    console.log("PICKUP_WAITING_ANCHOR_PICKUP_WAITING_STARTED_AT", {
      trip_id,
      pickup_waiting_started_at: pickupWaitingStartedAt,
      elapsed_seconds: elapsedSeconds,
      free_pickup_waiting_seconds: gracePeriodSeconds,
      waiting_charge_interval_seconds: intervalSeconds,
      waiting_charge_rounding: "completed_intervals",
      pickup_grace_source: config.pickup_grace_source,
    });

    if (!graceExpired || !paidWaitingEnabled) {
      return successResponse({
        success: true,
        elapsed_seconds: elapsedSeconds,
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
        elapsed_seconds: elapsedSeconds,
        grace_expired: true,
        paid_waiting_enabled: true,
        pickup_waiting_charge_pence: trip.pickup_waiting_charge_pence ?? 0,
        admin_waiting_config_snapshot: config,
        ...liveFareFields(trip as Record<string, unknown>),
      });
    }

    if (radiusEnabled && trip.pickup_latitude != null && trip.pickup_longitude != null && radiusMeters > 0) {
      if (typeof driver_lat !== "number" || typeof driver_lng !== "number") {
        return errorResponse(
          "GPS_REQUIRED",
          "Driver location required for paid pickup waiting (radius enforcement enabled).",
          400,
        );
      }
      const distance = haversineMeters(driver_lat, driver_lng, trip.pickup_latitude, trip.pickup_longitude);
      if (distance > radiusMeters) {
        return successResponse({
          success: true,
          no_op: true,
          reason: "outside_pickup_radius",
          elapsed_seconds: elapsedSeconds,
          grace_expired: true,
          paid_waiting_active: false,
          pickup_waiting_charge_pence: trip.pickup_waiting_charge_pence ?? 0,
          intervals_charged: trip.pickup_waiting_intervals_charged ?? 0,
          ...liveFareFields(trip as Record<string, unknown>),
        });
      }
    }

    const paidSeconds = Math.max(0, elapsedSeconds - gracePeriodSeconds);
    const charged = computePickupWaitingChargePence({
      paidSeconds,
      ratePencePerMinute: ratePPM,
      intervalSeconds,
      maxMinutes,
    });

    const prevIntervals = Number(trip.pickup_waiting_intervals_charged ?? 0);
    const prevCharge = Number(trip.pickup_waiting_charge_pence ?? 0);
    const nextChargeAt = new Date(
      waitingStartMs +
        (gracePeriodSeconds + (charged.intervals_charged + 1) * charged.interval_seconds) * 1000,
    ).toISOString();

    if (charged.intervals_charged === prevIntervals && charged.charge_pence === prevCharge) {
      return successResponse({
        success: true,
        idempotent: true,
        elapsed_seconds: elapsedSeconds,
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
        admin_waiting_config_snapshot: config,
        ...liveFareFields(trip as Record<string, unknown>, charged.charge_pence),
      });
    }

    const now = new Date(nowMs).toISOString();
    const chargeableStartedAt = new Date(waitingStartMs + gracePeriodSeconds * 1000).toISOString();
    const updateData: Record<string, unknown> = {
      pickup_waiting_charge_pence: charged.charge_pence,
      pickup_waiting_intervals_charged: charged.intervals_charged,
      pickup_waiting_chargeable_seconds: charged.paid_seconds_capped,
      pickup_waiting_last_tick_at: now,
    };
    if (!trip.grace_period_expired_at) updateData.grace_period_expired_at = chargeableStartedAt;
    if (!trip.pickup_paid_waiting_started_at && charged.charge_pence > 0) {
      updateData.pickup_paid_waiting_started_at = chargeableStartedAt;
    }

    await supabase.from("trips").update(updateData).eq("id", trip_id);

    return successResponse({
      success: true,
      elapsed_seconds: elapsedSeconds,
      grace_expired: true,
      grace_remaining_seconds: 0,
      free_wait_expires_at: freeWaitExpiresAt,
      paid_waiting_enabled: true,
      paid_waiting_active: true,
      paid_seconds: charged.paid_seconds_capped,
      chargeable_started_at: chargeableStartedAt,
      intervals_charged: charged.intervals_charged,
      charge_interval_seconds: charged.interval_seconds,
      pence_per_interval: charged.pence_per_interval,
      last_charge_tick_at: now,
      next_charge_at: nextChargeAt,
      capped: charged.paid_seconds_capped >= maxMinutes * 60,
      max_minutes: maxMinutes,
      pickup_waiting_charge_pence: charged.charge_pence,
      rate_pence_per_minute: ratePPM,
      waiting_charge_rounding: "completed_intervals",
      pickup_arrived_at: pickupArrivedAt,
      pickup_waiting_started_at: pickupWaitingStartedAt,
      admin_waiting_config_snapshot: config,
      ...liveFareFields(trip as Record<string, unknown>, charged.charge_pence),
    });
  } catch (err) {
    console.error("[tick-pickup-waiting-charge] Error:", err);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
