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
import { notifyDriverTripStopped } from "../_shared/notifyDriverTripStopped.ts";
import { disposeTerminalTripPayment } from "../_shared/terminalTripPaymentDisposition.ts";
import {
  disposeOutcomeIndicatesFeeCapture,
  mapFeeTypeToChargedOutcome,
  postChargedFeeTenViaRfo,
  resolveAssignedDriverId,
} from "../_shared/chargedTerminalFeeWalletSSOT.ts";

const RATE_LIMIT_CONFIG = {
  limit: 20,
  windowMs: 60000,
  keyPrefix: "late-cancellation-check",
};

/**
 * LATE CANCELLATION CHECK
 *
 * Called when a passenger cancels a trip (legacy / defensive path).
 * Primary cancel fee owner is cancel-trip — this Edge must still:
 *   - stamp charged-fee financial_outcome (commission 0)
 *   - dispose Revolut hold / capture fee
 *   - post TEN via record-financial-outcome only after proven capture
 *
 * CHARGE PRIORITY (single source of truth):
 *   1. No-show charge — overrides everything (handled by pickup-no-show)
 *   2. Cancellation fee after arrival — overrides waiting charges
 *   3. Late cancellation fee (pre-arrival) — applies if within threshold
 *   4. Otherwise → no fee, waiting charges (if any) remain
 *
 * Only ONE of {no_show, cancellation, late_cancel} may be applied per trip.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json();
    const { trip_id, cancelled_by } = body;

    if (!trip_id || !isValidUUID(trip_id)) {
      return validationErrorResponse({ trip_id: "Valid trip_id required" });
    }

    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select(
        "id, status, service_area_id, driver_id, confirmed_driver_id, created_at, is_scheduled, scheduled_at, accepted_at, arrived_at, no_show_charge_pence, late_cancel_fee_pence, total_waiting_charge_pence, pickup_waiting_charge_pence, payment_method",
      )
      .eq("id", trip_id)
      .single();

    if (tripErr || !trip) return errorResponse("NOT_FOUND", "Trip not found", 404);

    const driverIdEarly = trip.driver_id || trip.confirmed_driver_id;
    const cancelledByRole = cancelled_by || "passenger";

    const notifyDriverIfAssigned = async () => {
      if (!driverIdEarly) return;
      await notifyDriverTripStopped(supabaseUrl, serviceRoleKey, driverIdEarly, {
        tripId: trip_id,
        stopReason: "passenger_cancelled",
        cancelledBy: cancelledByRole,
        body: "Rider cancelled this trip",
      });
    };

    if (trip.status === "cancelled" || trip.status === "canceled") {
      await notifyDriverIfAssigned();
      return successResponse({
        success: true,
        fee_applied: false,
        reason: "Already cancelled",
      });
    }

    // PRIORITY 1: no-show already stamped — do not stack another fee here.
    if (Number(trip.no_show_charge_pence) > 0) {
      await notifyDriverIfAssigned();
      return successResponse({
        success: true,
        fee_applied: false,
        reason: "No-show charge already applied",
      });
    }

    const { data: settings } = await supabase
      .from("fare_pricing_settings")
      .select(
        "late_cancel_enabled, late_cancel_threshold_minutes, late_cancel_fee_pence, cancellation_fee_after_grace_pence, pickup_waiting_grace_period_seconds",
      )
      .eq("service_area_id", trip.service_area_id)
      .maybeSingle();

    const lateEnabled = settings?.late_cancel_enabled === true;
    const thresholdMinutes = settings?.late_cancel_threshold_minutes ?? 60;
    const lateFeePence = settings?.late_cancel_fee_pence ?? 500;
    const cancellationFeeAfterArrival = settings?.cancellation_fee_after_grace_pence ?? 500;
    const gracePeriodSec = settings?.pickup_waiting_grace_period_seconds ?? 300;

    const nowIso = new Date().toISOString();
    const settlementDriverId = resolveAssignedDriverId({
      driver_id: trip.driver_id,
      confirmed_driver_id: trip.confirmed_driver_id,
    });

    const settleChargedFee = async (args: {
      feePence: number;
      feeType: "late_cancellation" | "cancellation";
      financialOutcome: string;
      cancelReason: string;
      extraTripPatch?: Record<string, unknown>;
    }) => {
      const fee = Math.max(0, Math.round(Number(args.feePence) || 0));
      const tripPatch: Record<string, unknown> = {
        status: "cancelled",
        cancelled_at: nowIso,
        cancelled_by: cancelled_by || "passenger",
        cancel_reason: args.cancelReason,
        cancellation_fee_pence: fee,
        financial_outcome: args.financialOutcome,
        updated_at: nowIso,
        ...(args.extraTripPatch ?? {}),
      };
      if (fee > 0) {
        tripPatch.commission_pence = 0;
        tripPatch.commission_pct = 0;
        tripPatch.driver_net_pence = fee;
        tripPatch.driver_net_before_tip_pence = fee;
        tripPatch.gross_fare_pence = fee;
        if (args.feeType === "late_cancellation") {
          tripPatch.late_cancel_fee_pence = fee;
        }
      }

      await supabase.from("trips").update(tripPatch).eq("id", trip_id);

      if (settlementDriverId) {
        await supabase
          .from("drivers")
          .update({ current_trip_id: null, updated_at: nowIso })
          .eq("id", settlementDriverId);
      }

      await notifyDriverIfAssigned();

      let holdDisposition: Awaited<ReturnType<typeof disposeTerminalTripPayment>> | null = null;
      try {
        holdDisposition = await disposeTerminalTripPayment(supabase, {
          tripId: trip_id,
          reason: "customer_cancel",
          feePence: fee,
          forceFeePenceOverride: true,
        });
      } catch (e) {
        console.error("[late-cancellation-check] dispose failed", e);
        if (fee > 0) {
          return errorResponse(
            "FEE_DISPOSITION_FAILED",
            "Fee capture disposition failed after terminal trip update. No second capture attempted.",
            502,
          );
        }
      }

      const feeCaptured = fee > 0 && disposeOutcomeIndicatesFeeCapture(holdDisposition);
      if (feeCaptured) {
        const outcomeType = mapFeeTypeToChargedOutcome(args.feeType) ?? args.financialOutcome;
        const wallet = await postChargedFeeTenViaRfo({
          supabaseUrl,
          serviceRoleKey,
          tripId: trip_id,
          driverId: settlementDriverId,
          outcome: outcomeType,
          feePence: Math.round(Number(holdDisposition?.captured_fee_pence) || fee),
          paymentMethod: trip.payment_method || "unknown",
          disposition: holdDisposition,
        });
        if (wallet.status !== "SUCCEEDED") {
          console.error("[late-cancellation-check] WALLET_SETTLEMENT_FAILED_AFTER_FEE_CAPTURE", {
            trip_id,
            wallet,
            fee,
          });
          return errorResponse(
            "WALLET_SETTLEMENT_FAILED_AFTER_FEE_CAPTURE",
            wallet.status === "SKIPPED_NO_DRIVER"
              ? "Fee was captured but no assigned driver for wallet settlement. No second capture."
              : "Fee was captured but Driver Wallet settlement failed. No second capture.",
            502,
          );
        }
      }

      return successResponse({
        success: true,
        fee_applied: fee > 0,
        fee_type: args.feeType,
        fee_pence: fee,
        financial_outcome: args.financialOutcome,
        trip_id,
        hold_disposition_outcome: holdDisposition?.outcome ?? null,
      });
    };

    // PRIORITY 2: cancellation after driver has arrived → cancellation fee
    if (trip.arrived_at) {
      const arrivedAt = new Date(trip.arrived_at).getTime();
      const elapsedSec = Math.floor((Date.now() - arrivedAt) / 1000);
      const feePence = cancellationFeeAfterArrival;
      return await settleChargedFee({
        feePence,
        feeType: "cancellation",
        financialOutcome: "CANCELLED_WITH_FEE",
        cancelReason: elapsedSec >= gracePeriodSec
          ? "cancelled_after_grace"
          : "cancelled_after_arrival",
        extraTripPatch: {
          late_cancel_fee_pence: feePence,
          pickup_waiting_charge_pence: 0,
          total_waiting_charge_pence: 0,
        },
      });
    }

    // PRIORITY 3: pre-arrival late cancellation
    if (!lateEnabled) {
      if (trip.status !== "cancelled") {
        await supabase
          .from("trips")
          .update({
            status: "cancelled",
            cancelled_at: nowIso,
            cancelled_by: cancelled_by || "passenger",
            cancel_reason: "passenger_cancelled",
            financial_outcome: "CANCELLED_NO_FEE",
            updated_at: nowIso,
          })
          .eq("id", trip_id);
        if (settlementDriverId) {
          await supabase
            .from("drivers")
            .update({ current_trip_id: null, updated_at: nowIso })
            .eq("id", settlementDriverId);
        }
        await notifyDriverIfAssigned();
        try {
          await disposeTerminalTripPayment(supabase, {
            tripId: trip_id,
            reason: "customer_cancel",
            feePence: 0,
            forceFeePenceOverride: true,
          });
        } catch (e) {
          console.error("[late-cancellation-check] zero-fee dispose failed (non-fatal)", e);
        }
      }
      return successResponse({ success: true, fee_applied: false, reason: "Late cancellation fee disabled" });
    }

    let referenceTime: number | null = null;
    if (trip.is_scheduled && trip.scheduled_at) {
      referenceTime = new Date(trip.scheduled_at).getTime();
    } else if (trip.accepted_at) {
      referenceTime = new Date(trip.accepted_at).getTime() + thresholdMinutes * 60 * 1000;
    }

    if (!referenceTime) {
      return successResponse({ success: true, fee_applied: false, reason: "No reference time available" });
    }

    const now = Date.now();
    const isLate = trip.is_scheduled
      ? referenceTime - now <= thresholdMinutes * 60 * 1000
      : now >= referenceTime;

    if (!isLate) {
      if (trip.status !== "cancelled") {
        await supabase
          .from("trips")
          .update({
            status: "cancelled",
            cancelled_at: nowIso,
            cancelled_by: cancelled_by || "passenger",
            cancel_reason: "passenger_cancelled",
            financial_outcome: "CANCELLED_NO_FEE",
            updated_at: nowIso,
          })
          .eq("id", trip_id);
        if (settlementDriverId) {
          await supabase
            .from("drivers")
            .update({ current_trip_id: null, updated_at: nowIso })
            .eq("id", settlementDriverId);
        }
        await notifyDriverIfAssigned();
        try {
          await disposeTerminalTripPayment(supabase, {
            tripId: trip_id,
            reason: "customer_cancel",
            feePence: 0,
            forceFeePenceOverride: true,
          });
        } catch (e) {
          console.error("[late-cancellation-check] zero-fee dispose failed (non-fatal)", e);
        }
      }
      return successResponse({ success: true, fee_applied: false, reason: "Not within late cancellation window" });
    }

    return await settleChargedFee({
      feePence: lateFeePence,
      feeType: "late_cancellation",
      financialOutcome: "LATE_PASSENGER_CANCELLATION",
      cancelReason: "late_cancellation",
    });
  } catch (err) {
    console.error("[late-cancellation-check] Error:", err);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
