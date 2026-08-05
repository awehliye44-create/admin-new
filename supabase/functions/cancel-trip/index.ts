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
import { requireUser } from "../_shared/internalAuth.ts";
import { disposeTerminalTripPayment } from "../_shared/terminalTripPaymentDisposition.ts";
import {
  resolveTerminalPaymentDecision,
  validateCustomerNoShowEligibility,
  type FarePricingFeeConfig,
} from "../_shared/terminalFeeDecisionSSOT.ts";

/**
 * cancel-trip — terminalizes trip; fee + payment owned by terminalFeeDecisionSSOT /
 * terminalTripPaymentDisposition. Validates no-show eligibility before status write.
 */

const RATE_LIMIT_CONFIG = { limit: 30, windowMs: 60 * 1000 };

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const clientIP = getClientIP(req);
  const userAgent = req.headers.get("user-agent") || "unknown";

  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  try {
    // Require an authenticated caller (rider, driver, or admin)
    const authed = await requireUser(req);
    if (authed instanceof Response) return authed;
    const callerUserId = authed.userId;

    let body: {
      trip_id: string;
      cancelled_by: string; // 'rider' | 'driver' | 'admin'
      cancelled_by_id?: string;
      reason?: string;
      is_no_show?: boolean;
    };

    try {
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON", 400);
    }

    const { trip_id, cancelled_by, reason, is_no_show } = body;

    if (!trip_id || !cancelled_by) {
      return errorResponse("Missing trip_id or cancelled_by", 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch trip — ownership is passenger_id (customers.id). There is no trips.customer_id.
    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select(
        "id, status, driver_id, confirmed_driver_id, passenger_id, service_area_id, vehicle_type_id, assigned_at, arrived_at, cancellation_grace_expires_at, free_wait_expires_at, payment_method, waiting_minutes, waiting_charge_pence, scheduled_at"
      )
      .eq("id", trip_id)
      .single();

    if (tripErr || !trip) {
      console.error("[cancel-trip] trip lookup failed", {
        trip_id,
        message: tripErr?.message ?? "missing_row",
      });
      return errorResponse("Trip not found", 404);
    }

    // Verify caller is authorised: admin OR the rider OR the assigned driver of this trip
    let cancelled_by_id: string | null = null;
    const { data: adminRole } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", callerUserId)
      .in("role", ["admin", "super_admin"])
      .maybeSingle();

    if (adminRole) {
      cancelled_by_id = callerUserId;
    } else {
      // Try as rider (customers.user_id → trips.passenger_id)
      const { data: customer } = await supabase
        .from("customers")
        .select("id")
        .eq("user_id", callerUserId)
        .maybeSingle();
      if (customer && trip.passenger_id === customer.id) {
        cancelled_by_id = customer.id;
      } else {
        // Try as driver (drivers.user_id)
        const { data: driver } = await supabase
          .from("drivers")
          .select("id")
          .eq("user_id", callerUserId)
          .maybeSingle();
        if (
          driver &&
          (trip.driver_id === driver.id || trip.confirmed_driver_id === driver.id)
        ) {
          cancelled_by_id = driver.id;
        }
      }
    }

    if (!cancelled_by_id) {
      return errorResponse("Forbidden: caller not authorised to cancel this trip", 403);
    }

    const terminalStatuses = ["completed", "cancelled", "no_show"];
    if (terminalStatuses.includes(trip.status)) {
      return errorResponse(`Trip already in terminal status: ${trip.status}`, 400);
    }

    // Fetch fare pricing settings — Admin Panel is the single source of truth.
    // No fallback defaults: if config is missing, reject the request.
    if (!trip.service_area_id) {
      return errorResponse("Trip has no service_area_id — cannot resolve lifecycle rules", 400);
    }

    const fpsQuery = supabase
      .from("fare_pricing_settings")
      .select(
        "id, cancellation_fee_pence, cancellation_grace_period_minutes, cancellation_apply_after_arrival_only, no_show_fee_pence, no_show_wait_time_minutes, no_show_apply_after_arrival_only, waiting_per_minute_pence, late_cancel_enabled, late_cancel_threshold_minutes, late_cancel_fee_pence, arrival_cancellation_enabled, arrival_cancellation_fee_pence, arrival_cancellation_apply_after_free_waiting_expired, arrival_cancellation_after_arrival_only, free_waiting_minutes"
      )
      .eq("service_area_id", trip.service_area_id);

    if (trip.vehicle_type_id) {
      fpsQuery.eq("vehicle_type_id", trip.vehicle_type_id);
    }

    const { data: fps, error: fpsErr } = await fpsQuery.maybeSingle();

    if (fpsErr || !fps) {
      console.error(
        `[cancel-trip] No fare_pricing_settings found for service_area=${trip.service_area_id}, vehicle_type=${trip.vehicle_type_id}. Admin must configure lifecycle rules first.`
      );
      return errorResponse(
        "No fare pricing settings configured for this service area. Please configure lifecycle rules in Admin Panel.",
        422
      );
    }

    const feeConfig = fps as FarePricingFeeConfig & { id: string };
    const now = new Date();
    let tripStatus = "cancelled";
    let cancellationReasonFinal = reason || "cancelled";

    // ══════════════════════════════════════════
    // NO-SHOW PATH (driver-initiated, backend-authoritative)
    // ══════════════════════════════════════════
    if (is_no_show && cancelled_by === "driver") {
      const eligibility = validateCustomerNoShowEligibility({
        arrived_at: trip.arrived_at,
        no_show_apply_after_arrival_only: feeConfig.no_show_apply_after_arrival_only,
        no_show_wait_time_minutes: feeConfig.no_show_wait_time_minutes,
        nowMs: now.getTime(),
      });
      if (!eligibility.ok) {
        return errorResponse(eligibility.message, 400);
      }
      tripStatus = "no_show";
      cancellationReasonFinal = "no_show";
    } else if (cancelled_by === "driver") {
      cancellationReasonFinal = reason || "driver_cancelled";
    } else {
      cancellationReasonFinal = reason || "cancelled";
    }

    // Canonical fee decision (single winner) — used for trip stamp + response messaging.
    // disposeTerminalTripPayment re-resolves after the status write.
    const preDecision = resolveTerminalPaymentDecision({
      evidence: {
        trip_id,
        trip_status: tripStatus,
        started_at: null,
        arrived_at: trip.arrived_at ?? null,
        free_wait_expires_at: trip.free_wait_expires_at ?? null,
        cancelled_at: now.toISOString(),
        cancelled_by,
        scheduled_at: trip.scheduled_at ?? null,
        cancellation_grace_expires_at: trip.cancellation_grace_expires_at ?? null,
        driver_id: trip.driver_id ?? null,
        confirmed_driver_id: trip.confirmed_driver_id ?? null,
        no_show_recorded: tripStatus === "no_show",
        authorised_amount_pence: 0,
        previously_captured_amount_pence: 0,
        payment_session_id: null,
        provider: "revolut",
        decision_at: now.toISOString(),
      },
      config: feeConfig,
      feePolicyId: feeConfig.id,
    });

    const appliedFee = preDecision.fee_amount_pence;
    const feeType =
      preDecision.fee_type === "customer_no_show"
        ? "no_show"
        : preDecision.fee_type === "arrival_cancellation"
        ? "arrival_cancellation"
        : preDecision.fee_type === "late_passenger_cancellation"
        ? "late_cancellation"
        : preDecision.fee_type === "cancellation"
        ? "cancellation"
        : "none";
    const financialOutcome =
      appliedFee > 0
        ? feeType === "no_show"
          ? "NO_SHOW"
          : "CANCELLED_WITH_FEE"
        : "CANCELLED_NO_FEE";
    if (preDecision.disposition_reason === "LATE_PASSENGER_CANCELLATION") {
      cancellationReasonFinal = reason || "late_passenger_cancellation";
    } else if (preDecision.disposition_reason === "ARRIVAL_CANCELLATION_FEE") {
      cancellationReasonFinal = reason || "arrival_cancellation_fee";
    }

    // ══════════════════════════════════════════
    // UPDATE TRIP
    // ══════════════════════════════════════════
    const tripUpdate: Record<string, unknown> = {
      status: tripStatus,
      cancelled_at: now.toISOString(),
      cancelled_by: cancelled_by,
      cancellation_reason: cancellationReasonFinal,
      cancellation_fee_pence: appliedFee,
      financial_outcome: financialOutcome,
      driver_id: null,
      confirmed_driver_id: null,
      negotiation_owner_driver_id: null,
      current_offer_driver_id: null,
      negotiation_locked_until: null,
      current_offer_expires_at: null,
      searching_expires_at: null,
      dispatch_status: "cancelled",
      updated_at: now.toISOString(),
    };
    if (feeType === "no_show") {
      tripUpdate.no_show_charge_pence = appliedFee;
    }
    if (feeType === "arrival_cancellation") {
      tripUpdate.arrival_cancellation_applied = true;
      tripUpdate.arrival_cancellation_fee = appliedFee / 100;
      tripUpdate.arrival_cancellation_applied_at = now.toISOString();
      tripUpdate.arrival_cancellation_reason = "ARRIVAL_CANCELLATION_FEE";
    }
    if (feeType === "late_cancellation") {
      tripUpdate.late_cancel_fee_pence = appliedFee;
    }

    const { error: updateErr } = await supabase
      .from("trips")
      .update(tripUpdate)
      .eq("id", trip_id);

    if (updateErr) {
      console.error("[cancel-trip] update error:", updateErr);
      return errorResponse("Failed to cancel trip", 500);
    }

    // Clear driver's current trip if driver was assigned
    const assignedDriverId = trip.confirmed_driver_id ?? trip.driver_id ?? null;
    if (assignedDriverId) {
      await supabase
        .from("drivers")
        .update({ current_trip_id: null })
        .eq("id", assignedDriverId);
    }

    await supabase
      .from("customers")
      .update({ active_trip_id: null, updated_at: now.toISOString() })
      .eq("active_trip_id", trip_id);

    // Record financial outcome if fee > 0
    if (appliedFee > 0 && trip.driver_id) {
      const outcomeType = feeType === "no_show"
        ? "NO_SHOW"
        : feeType === "late_cancellation"
        ? "LATE_PASSENGER_CANCELLATION"
        : feeType === "arrival_cancellation"
        ? "ARRIVAL_CANCELLATION"
        : "CANCELLATION_FEE";

      try {
        const fnUrl = `${supabaseUrl}/functions/v1/record-financial-outcome`;
        await fetch(fnUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({
            trip_id,
            driver_id: trip.driver_id,
            outcome: outcomeType,
            fee_pence: appliedFee,
            payment_method: trip.payment_method || "unknown",
          }),
        });
      } catch (finErr) {
        console.error("[cancel-trip] record-financial-outcome error:", finErr);
      }
    }

    await logAuditEvent(supabase, "trip_cancelled", {
      driverId: trip.driver_id || undefined,
      tripId: trip_id,
      details: {
        cancelled_by,
        cancelled_by_id,
        fee_type: feeType,
        fee_pence: appliedFee,
        reason: cancellationReasonFinal,
        financial_outcome: financialOutcome,
        disposition_reason: preDecision.disposition_reason,
        was_arrived: !!trip.arrived_at,
        was_within_grace: appliedFee === 0 && feeType === "none",
        is_scheduled: !!trip.scheduled_at,
        late_cancel_enabled: feeConfig.late_cancel_enabled,
        late_cancel_threshold_minutes: feeConfig.late_cancel_threshold_minutes,
        late_cancel_fee_pence: feeConfig.late_cancel_fee_pence,
        arrival_cancellation_enabled: feeConfig.arrival_cancellation_enabled,
      },
      ipAddress: clientIP,
      userAgent,
    });

    console.log(
      `[cancel-trip] Trip ${trip_id}: status=${tripStatus}, fee=${appliedFee}p, type=${feeType}, outcome=${financialOutcome}, disposition=${preDecision.disposition_reason}`
    );

    // Payment disposition — canonical resolver re-runs inside dispose (no fee override).
    let paymentDisposition: Record<string, unknown> | null = null;
    try {
      const dispositionReason =
        cancelled_by === "admin"
          ? "admin_cancel"
          : cancelled_by === "driver"
          ? "driver_cancel_terminal"
          : "customer_cancel";
      const disposition = await disposeTerminalTripPayment(supabase, {
        tripId: trip_id,
        reason: dispositionReason,
      });
      paymentDisposition = disposition as unknown as Record<string, unknown>;
      console.log(
        `[cancel-trip] payment disposition trip=${trip_id} outcome=${disposition.outcome} order=${disposition.provider_order_id_mask ?? "—"}`,
      );
    } catch (dispErr) {
      console.error("[cancel-trip] payment disposition error (trip remains cancelled; sweep will retry):", dispErr);
      paymentDisposition = {
        outcome: "PROVIDER_PENDING_RECONCILIATION",
        message: dispErr instanceof Error ? dispErr.message : String(dispErr),
      };
    }

    // Response messages for apps
    let riderMessage = "Trip cancelled";
    let driverMessage = "Trip has been cancelled";

    if (feeType === "none" && cancelled_by === "rider") {
      riderMessage = "Trip cancelled — no charge";
      driverMessage = "Rider cancelled within grace period — no fee";
    } else if (feeType === "cancellation") {
      riderMessage = `Trip cancelled — cancellation fee of ${appliedFee}p applied`;
      driverMessage = "Rider cancelled — cancellation fee applied";
    } else if (feeType === "no_show") {
      riderMessage = `No-show fee of ${appliedFee}p applied`;
      driverMessage = "Passenger no-show — fee applied";
    } else if (feeType === "late_cancellation") {
      riderMessage = `Trip cancelled — late cancellation fee of ${appliedFee}p applied`;
      driverMessage = "Rider cancelled late — late cancellation fee applied";
    } else if (feeType === "arrival_cancellation") {
      riderMessage = `Trip cancelled — arrival cancellation fee of ${appliedFee}p applied`;
      driverMessage = "Rider cancelled after free waiting — arrival cancellation fee applied";
    }

    return successResponse({
      trip_id,
      status: tripStatus,
      fee_type: feeType,
      fee_pence: appliedFee,
      financial_outcome: financialOutcome,
      disposition_reason: preDecision.disposition_reason,
      cancelled_by,
      reason: cancellationReasonFinal,
      rider_message: riderMessage,
      driver_message: driverMessage,
      payment_disposition: paymentDisposition,
    });
  } catch (err) {
    console.error("[cancel-trip] Error:", err);
    return errorResponse(err instanceof Error ? err.message : "Unknown error", 500);
  }
});
