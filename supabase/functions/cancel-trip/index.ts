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
 * cancel-trip
 *
 * Handles cancellation logic for both riders and drivers.
 * Implements the two-phase grace period:
 *   A) Post-booking (after driver assigned, before arrival)
 *   B) Post-arrival (after driver taps arrived)
 *
 * Uses existing fare_pricing_settings fields:
 *   - cancellation_grace_period_minutes
 *   - cancellation_fee_pence
 *   - cancellation_apply_after_arrival_only
 *   - no_show_fee_pence
 *   - no_show_wait_time_minutes
 *   - no_show_apply_after_arrival_only
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
    let body: {
      trip_id: string;
      cancelled_by: string; // 'rider' | 'driver' | 'admin'
      cancelled_by_id: string;
      reason?: string;
      is_no_show?: boolean;
    };

    try {
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON", 400);
    }

    const { trip_id, cancelled_by, cancelled_by_id, reason, is_no_show } = body;

    if (!trip_id || !cancelled_by || !cancelled_by_id) {
      return errorResponse("Missing trip_id, cancelled_by, or cancelled_by_id", 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch trip
    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select(
        "id, status, driver_id, service_area_id, vehicle_type_id, assigned_at, arrived_at, cancellation_grace_expires_at, free_wait_expires_at, payment_method, waiting_minutes, waiting_charge_pence, scheduled_at"
      )
      .eq("id", trip_id)
      .single();

    if (tripErr || !trip) {
      return errorResponse("Trip not found", 404);
    }

    const terminalStatuses = ["completed", "cancelled", "no_show"];
    if (terminalStatuses.includes(trip.status)) {
      return errorResponse(`Trip already in terminal status: ${trip.status}`, 400);
    }

    // Fetch fare pricing settings
    let cancellationFeePence = 0;
    let cancellationGracePeriodMinutes = 3;
    let cancellationApplyAfterArrivalOnly = false;
    let noShowFeePence = 0;
    let noShowWaitTimeMinutes = 5;
    let noShowApplyAfterArrivalOnly = true;
    let waitingPerMinutePence = 0;
    let lateCancelEnabled = false;
    let lateCancelThresholdMinutes = 0;
    let lateCancelFeePence = 0;

    if (trip.service_area_id) {
      const fpsQuery = supabase
        .from("fare_pricing_settings")
        .select(
          "cancellation_fee_pence, cancellation_grace_period_minutes, cancellation_apply_after_arrival_only, no_show_fee_pence, no_show_wait_time_minutes, no_show_apply_after_arrival_only, waiting_per_minute_pence, late_cancel_enabled, late_cancel_threshold_minutes, late_cancel_fee_pence"
        )
        .eq("service_area_id", trip.service_area_id);

      if (trip.vehicle_type_id) {
        fpsQuery.eq("vehicle_type_id", trip.vehicle_type_id);
      }

      const { data: fps } = await fpsQuery.maybeSingle();
      if (fps) {
        cancellationFeePence = fps.cancellation_fee_pence ?? 0;
        cancellationGracePeriodMinutes = fps.cancellation_grace_period_minutes ?? 3;
        cancellationApplyAfterArrivalOnly = fps.cancellation_apply_after_arrival_only ?? false;
        noShowFeePence = fps.no_show_fee_pence ?? 0;
        noShowWaitTimeMinutes = fps.no_show_wait_time_minutes ?? 5;
        noShowApplyAfterArrivalOnly = fps.no_show_apply_after_arrival_only ?? true;
        waitingPerMinutePence = fps.waiting_per_minute_pence ?? 0;
        lateCancelEnabled = fps.late_cancel_enabled ?? false;
        lateCancelThresholdMinutes = fps.late_cancel_threshold_minutes ?? 0;
        lateCancelFeePence = fps.late_cancel_fee_pence ?? 0;
      }
    }

    const now = new Date();
    let appliedFee = 0;
    let feeType = "none";
    let cancellationReasonFinal = reason || "cancelled";
    let financialOutcome = "CANCELLED_NO_FEE";
    let tripStatus = "cancelled";

    // ══════════════════════════════════════════
    // NO-SHOW PATH (driver-initiated)
    // ══════════════════════════════════════════
    if (is_no_show && cancelled_by === "driver") {
      if (noShowApplyAfterArrivalOnly && !trip.arrived_at) {
        return errorResponse("No-show can only be triggered after driver arrival", 400);
      }

      // Check if enough waiting time has passed
      if (trip.arrived_at) {
        const arrivedAt = new Date(trip.arrived_at);
        const waitedMinutes = (now.getTime() - arrivedAt.getTime()) / 60000;

        if (waitedMinutes < noShowWaitTimeMinutes) {
          return errorResponse(
            `Must wait ${noShowWaitTimeMinutes} minutes before no-show. Waited: ${Math.floor(waitedMinutes)} min`,
            400
          );
        }
      }

      appliedFee = noShowFeePence;
      feeType = "no_show";
      cancellationReasonFinal = "no_show";
      financialOutcome = "NO_SHOW";
      tripStatus = "no_show";

      // Calculate any accumulated waiting charge
      const waitingCharge = trip.waiting_charge_pence || 0;

      console.log(
        `[cancel-trip] NO_SHOW trip ${trip_id}: fee=${appliedFee}p, waiting=${waitingCharge}p`
      );
    }
    // ══════════════════════════════════════════
    // CANCELLATION PATH (rider or admin)
    // ══════════════════════════════════════════
    else if (cancelled_by === "rider" || cancelled_by === "admin") {
      const driverAssigned = !!trip.driver_id;
      const driverArrived = !!trip.arrived_at;

      // ── LATE PASSENGER CANCELLATION CHECK (scheduled trips) ──
      // Evaluated first: if the trip has a scheduled_at time and late_cancel is enabled,
      // check if we're within the threshold window before pickup.
      // For immediate trips (no scheduled_at), this block is skipped entirely.
      let lateCancelApplied = false;

      if (lateCancelEnabled && trip.scheduled_at) {
        const scheduledPickup = new Date(trip.scheduled_at);
        const timeToPickupMinutes = (scheduledPickup.getTime() - now.getTime()) / 60000;

        console.log(
          `[cancel-trip] LATE_CANCEL check: trip=${trip_id}, scheduled_at=${trip.scheduled_at}, ` +
          `time_to_pickup=${timeToPickupMinutes.toFixed(1)}min, threshold=${lateCancelThresholdMinutes}min, ` +
          `late_cancel_fee=${lateCancelFeePence}p, late_cancel_enabled=${lateCancelEnabled}`
        );

        if (timeToPickupMinutes <= lateCancelThresholdMinutes) {
          // Within threshold → apply late cancellation fee
          appliedFee = lateCancelFeePence;
          feeType = "late_cancellation";
          cancellationReasonFinal = reason || "late_passenger_cancellation";
          financialOutcome = "CANCELLED_WITH_FEE";
          lateCancelApplied = true;

          console.log(
            `[cancel-trip] LATE_CANCEL APPLIED: trip=${trip_id}, fee=${lateCancelFeePence}p, ` +
            `time_to_pickup=${timeToPickupMinutes.toFixed(1)}min <= threshold=${lateCancelThresholdMinutes}min`
          );
        } else {
          console.log(
            `[cancel-trip] LATE_CANCEL SKIPPED: trip=${trip_id}, ` +
            `time_to_pickup=${timeToPickupMinutes.toFixed(1)}min > threshold=${lateCancelThresholdMinutes}min — no fee`
          );
        }
      } else if (lateCancelEnabled && !trip.scheduled_at) {
        // Immediate trip with late_cancel enabled — not applicable
        console.log(
          `[cancel-trip] LATE_CANCEL N/A: trip=${trip_id} is immediate (no scheduled_at), skipping late cancel check`
        );
      }

      // If late cancel was applied, skip the standard grace/cancellation logic
      if (!lateCancelApplied) {
        // PHASE A: Post-booking, pre-arrival cancellation
        if (driverAssigned && !driverArrived) {
          if (cancellationApplyAfterArrivalOnly) {
            appliedFee = 0;
            feeType = "none";
            cancellationReasonFinal = reason || "cancelled_pre_arrival";
          } else {
            const graceExpires = trip.cancellation_grace_expires_at
              ? new Date(trip.cancellation_grace_expires_at)
              : null;

            if (graceExpires && now <= graceExpires) {
              appliedFee = 0;
              feeType = "none";
              cancellationReasonFinal = "post_booking_grace";
              financialOutcome = "CANCELLED_NO_FEE";
            } else {
              appliedFee = cancellationFeePence;
              feeType = "cancellation";
              cancellationReasonFinal = reason || "cancelled_after_grace";
              financialOutcome = "CANCELLED_WITH_FEE";
            }
          }
        }
        // PHASE B: Post-arrival cancellation
        else if (driverArrived) {
          const arrivalGraceExpires = trip.cancellation_grace_expires_at
            ? new Date(trip.cancellation_grace_expires_at)
            : null;

          if (arrivalGraceExpires && now <= arrivalGraceExpires) {
            appliedFee = 0;
            feeType = "none";
            cancellationReasonFinal = "arrival_grace_period";
            financialOutcome = "CANCELLED_NO_FEE";
          } else {
            appliedFee = cancellationFeePence;
            feeType = "cancellation";
            cancellationReasonFinal = reason || "cancelled_after_arrival_grace";
            financialOutcome = "CANCELLED_WITH_FEE";
          }
        }
        // No driver assigned → always free
        else {
          appliedFee = 0;
          feeType = "none";
          cancellationReasonFinal = reason || "cancelled_no_driver";
          financialOutcome = "CANCELLED_NO_FEE";
        }
      }
    }
    // Driver cancellation (not no-show)
    else if (cancelled_by === "driver") {
      appliedFee = 0;
      feeType = "none";
      cancellationReasonFinal = reason || "driver_cancelled";
      financialOutcome = "CANCELLED_NO_FEE";
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
      updated_at: now.toISOString(),
    };

    const { error: updateErr } = await supabase
      .from("trips")
      .update(tripUpdate)
      .eq("id", trip_id);

    if (updateErr) {
      console.error("[cancel-trip] update error:", updateErr);
      return errorResponse("Failed to cancel trip", 500);
    }

    // Clear driver's current trip if driver was assigned
    if (trip.driver_id) {
      await supabase
        .from("drivers")
        .update({ current_trip_id: null })
        .eq("id", trip.driver_id);
    }

    // Record financial outcome if fee > 0
    if (appliedFee > 0 && trip.driver_id) {
      const outcomeType = feeType === "no_show" ? "NO_SHOW" 
        : feeType === "late_cancellation" ? "LATE_PASSENGER_CANCELLATION" 
        : "LATE_PASSENGER_CANCELLATION";

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
        was_arrived: !!trip.arrived_at,
        was_within_grace: appliedFee === 0 && feeType === "none",
      },
      ipAddress: clientIP,
      userAgent,
    });

    console.log(
      `[cancel-trip] Trip ${trip_id}: status=${tripStatus}, fee=${appliedFee}p, type=${feeType}, outcome=${financialOutcome}`
    );

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
    }

    return successResponse({
      trip_id,
      status: tripStatus,
      fee_type: feeType,
      fee_pence: appliedFee,
      financial_outcome: financialOutcome,
      cancelled_by,
      reason: cancellationReasonFinal,
      rider_message: riderMessage,
      driver_message: driverMessage,
    });
  } catch (err) {
    console.error("[cancel-trip] Error:", err);
    return errorResponse(err instanceof Error ? err.message : "Unknown error", 500);
  }
});
