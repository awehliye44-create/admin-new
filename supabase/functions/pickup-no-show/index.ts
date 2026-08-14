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
import { resolveDriverArrivedAtIso } from "../_shared/pickupWaiting.ts";
import {
  evaluateCanMarkNoShow,
  loadNoShowDispatchRules,
  loadNoShowPricingRules,
} from "../_shared/tripNoShowRules.ts";
import { isCashPayment, settleNoShowFee } from "../_shared/noShowSettlement.ts";
import { computeCaptureAmount } from "../_shared/tripFareSSOT.ts";
import { handleQueuedTripAfterCurrentTripFailure } from "../_shared/stackedRideLifecycle.ts";

const RATE_LIMIT_CONFIG = {
  limit: 10,
  windowMs: 60000,
  keyPrefix: "pickup-no-show",
};

// (userIdFromAuthHeader helper removed for signature verification security)

/**
 * PICKUP NO-SHOW — validates lifecycle rules, charges fee, sets trip terminal status.
 *
 * Business-rule failures return HTTP 200 + { success: false, message } so the driver app
 * can show a clear message instead of a generic non-2xx invoke error.
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

    // stripe_payment_intent_id intentionally omitted — column dropped; Revolut is SSOT.
    const tripSelectCols =
      "id, confirmed_driver_id, passenger_id, status, arrived_at, pickup_arrived_at, service_area_id, vehicle_type_id, pickup_latitude, pickup_longitude, driver_location_lat, driver_location_lng, payment_method, currency_code, no_show_charge_pence, completed_at";

    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select(tripSelectCols)
      .eq("id", trip_id)
      .single();

    if (tripErr || !trip) return errorResponse("NOT_FOUND", "Trip not found", 404);

    console.log("NO_SHOW_SELECT_PROD_SAFE", { trip_id, select_cols: tripSelectCols });
    console.log("DRIVER_ARRIVED_AT_COLUMN_REMOVED_FROM_SELECTS", {
      function: "pickup-no-show",
      canonical_arrival_fields: ["pickup_arrived_at", "arrived_at"],
    });
    if (trip.confirmed_driver_id !== driver.id) {
      return errorResponse("FORBIDDEN", "Not your trip", 403);
    }

    const tripStatusNorm = String(trip.status || "").toLowerCase();
    if (tripStatusNorm === "no_show") {
      return successResponse({
        success: true,
        idempotent: true,
        status: "no_show",
        message: "No-show already recorded for this trip.",
      });
    }

    let resolvedDriverLat = typeof driver_lat === "number" ? driver_lat : undefined;
    let resolvedDriverLng = typeof driver_lng === "number" ? driver_lng : undefined;
    if (resolvedDriverLat == null || resolvedDriverLng == null) {
      const { data: driverGeo } = await supabase
        .from("drivers")
        .select("current_lat, current_lng")
        .eq("id", driver.id)
        .maybeSingle();
      resolvedDriverLat =
        resolvedDriverLat ??
        (typeof driverGeo?.current_lat === "number" ? driverGeo.current_lat : undefined) ??
        (typeof trip.driver_location_lat === "number" ? trip.driver_location_lat : undefined);
      resolvedDriverLng =
        resolvedDriverLng ??
        (typeof driverGeo?.current_lng === "number" ? driverGeo.current_lng : undefined) ??
        (typeof trip.driver_location_lng === "number" ? trip.driver_location_lng : undefined);
    }

    const terminal = new Set(["completed", "cancelled", "canceled", "no_show", "expired"]);
    if (terminal.has(String(trip.status || "").toLowerCase())) {
      return successResponse({
        success: false,
        message: "This trip has already ended.",
      });
    }

    const pickupArrivedAt = await resolveDriverArrivedAtIso(supabase, trip_id, trip);
    console.log("PICKUP_ARRIVAL_TIMESTAMP_LOADED", {
      trip_id,
      pickup_arrived_at: pickupArrivedAt,
      trip_pickup_arrived_at: trip.pickup_arrived_at ?? null,
      trip_arrived_at: trip.arrived_at ?? null,
    });
    console.log("NO_SHOW_ANCHOR_DRIVER_ARRIVED_AT", {
      trip_id,
      pickup_arrived_at: pickupArrivedAt,
    });
    if (!pickupArrivedAt) {
      console.log("NO_SHOW_BLOCKED_NO_ARRIVAL_TIMESTAMP", {
        trip_id,
        reason: "no_pickup_arrival_anchor",
      });
      return successResponse({
        success: false,
        message: "No arrival time recorded — tap Arrived at pickup first.",
      });
    }
    const pricing = await loadNoShowPricingRules(
      supabase,
      trip.service_area_id,
      trip.vehicle_type_id,
    );
    const dispatch = await loadNoShowDispatchRules(supabase, trip.service_area_id);

    const eligibility = evaluateCanMarkNoShow({
      tripStatus: trip.status,
      arrivedAtIso: pickupArrivedAt,
      pricing,
      dispatch,
      driverLat: resolvedDriverLat,
      driverLng: resolvedDriverLng,
      pickupLat: trip.pickup_latitude,
      pickupLng: trip.pickup_longitude,
    });

    if (!eligibility.canMark) {
      console.log("[pickup-no-show] Not eligible:", trip_id, eligibility.message);
      return successResponse({
        success: false,
        message: eligibility.message,
      });
    }

    const configuredNoShowFeePence = pricing.noShowFeePence;
    const cashTrip = isCashPayment(trip.payment_method);
    const effectiveNoShowFeePence = cashTrip ? 0 : configuredNoShowFeePence;
    const now = new Date().toISOString();

    let updateErr = (await supabase
      .from("trips")
      .update({
        status: "no_show",
        completed_at: trip.completed_at ?? now,
        cancelled_at: null,
        cancelled_by: null,
        cancelled_by_role: null,
        cancel_reason: null,
        cancellation_reason: "no_show",
        no_show_by: "driver",
        no_show_charge_pence: effectiveNoShowFeePence,
        late_cancel_fee_pence: 0,
        pickup_waiting_charge_pence: 0,
        total_waiting_charge_pence: 0,
        grace_period_expired_at: now,
        updated_at: now,
      })
      .eq("id", trip_id)
      .eq("confirmed_driver_id", driver.id)).error;

    if (updateErr?.message?.includes("no_show_by")) {
      console.warn("[pickup-no-show] no_show_by column missing — retry without actor column");
      updateErr = (await supabase
        .from("trips")
        .update({
          status: "no_show",
          completed_at: trip.completed_at ?? now,
          cancelled_at: null,
          cancelled_by: null,
          cancelled_by_role: null,
          cancel_reason: null,
          cancellation_reason: "no_show",
          no_show_charge_pence: effectiveNoShowFeePence,
          late_cancel_fee_pence: 0,
          pickup_waiting_charge_pence: 0,
          total_waiting_charge_pence: 0,
          grace_period_expired_at: now,
          updated_at: now,
        })
        .eq("id", trip_id)
        .eq("confirmed_driver_id", driver.id)).error;
    }

    if (updateErr) {
      console.error("[pickup-no-show] Trip update failed:", updateErr);
      return errorResponse("UPDATE_FAILED", "Could not update trip — please try again", 500);
    }

    console.log("NO_SHOW_TERMINAL_CONFIRMED", JSON.stringify({
      trip_id,
      driver_id: driver.id,
      status: "no_show",
      no_show_by: "driver",
      payment_method: trip.payment_method,
      configured_no_show_fee_pence: configuredNoShowFeePence,
      effective_no_show_fee_pence: effectiveNoShowFeePence,
      cash_zero_policy: cashTrip,
    }));

    await supabase
      .from("drivers")
      .update({ current_trip_id: null, active_trip_id: null, updated_at: now })
      .eq("id", driver.id);

    await handleQueuedTripAfterCurrentTripFailure(supabase, {
      currentTripId: trip_id,
      driverId: driver.id,
      failureReason: "pickup_no_show",
    });

    if (trip.passenger_id) {
      await supabase
        .from("customers")
        .update({ active_trip_id: null })
        .eq("id", trip.passenger_id)
        .eq("active_trip_id", trip_id);
    }

    let cardCharged = false;
    if (effectiveNoShowFeePence > 0 && !cashTrip && trip.payment_method !== "wallet") {
      const noShowCapture = computeCaptureAmount(
        { ...trip, no_show_charge_pence: effectiveNoShowFeePence },
        "card_no_show",
      );
      const captureAmountPence = noShowCapture.capture_amount_pence;
      try {
        const chargeRes = await fetch(`${supabaseUrl}/functions/v1/charge-lifecycle-fee`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceRoleKey}`,
          },
          body: JSON.stringify({
            trip_id,
            fee_type: "no_show",
            amount_pence: captureAmountPence,
            description: "No-show fee",
          }),
        });
        const chargeResult = await chargeRes.json();
        cardCharged =
          chargeResult?.success === true &&
          (chargeResult?.charged === true || chargeResult?.already_charged === true);
        console.log("[pickup-no-show] charge-lifecycle-fee:", JSON.stringify(chargeResult));
      } catch (chargeErr) {
        console.error("[pickup-no-show] charge-lifecycle-fee failed (non-fatal):", chargeErr);
      }
    }

    let settlement: Awaited<ReturnType<typeof settleNoShowFee>>;
    try {
      settlement = await settleNoShowFee({
        supabase,
        tripId: trip_id,
        driverId: driver.id,
        passengerId: trip.passenger_id ?? null,
        paymentMethod: trip.payment_method,
        currencyCode: trip.currency_code,
        feePence: effectiveNoShowFeePence,
        cardCharged,
        serviceRoleKey,
        supabaseUrl,
      });
      console.log("[pickup-no-show] Recorded:", trip_id, settlement);
    } catch (settleErr) {
      console.error("[pickup-no-show] Settlement failed (trip already no_show):", settleErr);
      settlement = {
        paymentStatus: "no_show_company_compensated",
        driverCompensated: false,
        customerDebtPence: 0,
        driverMessage: "No-show recorded. Fee will be handled by ONECAB.",
      };
    }
    console.log("NO_SHOW_REMATCH_BLOCKED", JSON.stringify({
      trip_id,
      reason: "no_show_is_terminal",
    }));

    return successResponse({
      success: true,
      status: "no_show",
      trip_id,
      no_show_fee_pence: effectiveNoShowFeePence,
      configured_no_show_fee_pence: configuredNoShowFeePence,
      charged: cardCharged,
      payment_status: settlement.paymentStatus,
      driver_compensated: settlement.driverCompensated,
      customer_debt_pence: settlement.customerDebtPence,
      message: settlement.driverMessage,
    });
  } catch (err) {
    console.error("[pickup-no-show] Error:", err);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
