import { createClient } from "npm:@supabase/supabase-js@2.57.2";
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
import { notifyCustomerTripLifecycle } from "../_shared/customerTripLifecycleNotify.ts";
import { maybeResumeTerminalFeeSettlementAfterProviderFee } from "../_shared/terminalFeeSettlementResumptionSSOT.ts";
import { assertServiceRole } from "../_shared/internalAuth.ts";
import { requireAuthenticatedUser } from "../_shared/edgeAuth.ts";
import {
  authoriseLateCancellationCaller,
  type LateCancelCaller,
} from "../_shared/lateCancellationCallerAuthSSOT.ts";
import {
  buildCancelledScheduledStatePatch,
  TERMINAL_TRIP_STATUS_POSTGREST_LIST,
} from "../_shared/tripTerminalDispatch.ts";

const RATE_LIMIT_CONFIG = {
  limit: 20,
  windowMs: 60000,
  keyPrefix: "late-cancellation-check",
};

/**
 * LATE CANCELLATION CHECK
 *
 * Called when a passenger cancels a trip.
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

    let caller: LateCancelCaller;
    if (assertServiceRole(req) === null) {
      caller = { kind: "service_role" };
    } else {
      const auth = await requireAuthenticatedUser(req, supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!);
      if (!auth.ok) return auth.response;
      const { data: staff } = await supabase
        .from("staff_profiles")
        .select("role, is_active")
        .eq("user_id", auth.userId)
        .maybeSingle();
      if (staff) {
        caller = {
          kind: "staff",
          userId: auth.userId,
          role: String(staff.role ?? ""),
          isActive: staff.is_active !== false,
        };
      } else {
        const { data: customers } = await supabase
          .from("customers")
          .select("id")
          .eq("user_id", auth.userId);
        caller = {
          kind: "user",
          userId: auth.userId,
          customerIds: (customers ?? []).map((c: { id: string }) => String(c.id)),
        };
      }
    }

    const body = await req.json();
    const { trip_id } = body;

    if (!trip_id || !isValidUUID(trip_id)) {
      return validationErrorResponse({ trip_id: "Valid trip_id required" });
    }

    // Get trip — include arrival/no-show/waiting fields for priority resolution
    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select(
        "id, status, service_area_id, driver_id, confirmed_driver_id, passenger_id, created_at, is_scheduled, scheduled_at, accepted_at, arrived_at, no_show_charge_pence, late_cancel_fee_pence, total_waiting_charge_pence, pickup_waiting_charge_pence, completed_at"
      )
      .eq("id", trip_id)
      .single();

    if (tripErr || !trip) return errorResponse("NOT_FOUND", "Trip not found", 404);

    const authz = authoriseLateCancellationCaller({
      caller,
      tripPassengerId: trip.passenger_id,
      requestedCancelledBy: body.cancelled_by,
    });
    if (!authz.ok) {
      console.warn("[late-cancellation-check] caller rejected", { trip_id, code: authz.code, caller: caller.kind });
      return errorResponse(authz.code, "Not allowed to cancel this trip", authz.status);
    }
    const cancelled_by = authz.cancelledBy;

    const driverIdEarly = trip.driver_id || trip.confirmed_driver_id;
    const preservedDriver = driverIdEarly ? { previous_driver_id: driverIdEarly } : {};
    const cancelledByRole = cancelled_by;
    const scheduledCancelPatch = buildCancelledScheduledStatePatch(trip);

    // Every cancel write is conditional: a trip that completed or reached a
    // terminal status after the read above must not be overwritten.
    const cancelTripRow = async (patch: Record<string, unknown>): Promise<boolean> => {
      const { data: rows, error } = await supabase
        .from("trips")
        .update({ ...patch, ...scheduledCancelPatch })
        .eq("id", trip_id)
        .is("completed_at", null)
        .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
        .select("id");
      if (error) {
        console.error("[late-cancellation-check] cancel update failed", { trip_id, error: error.message });
        return false;
      }
      return (rows ?? []).length > 0;
    };
    const terminalConflict = () =>
      errorResponse("TRIP_TERMINAL", "Trip completed or reached a terminal status before it could be cancelled", 409);

    const notifyDriverIfAssigned = async () => {
      if (!driverIdEarly) return;
      await notifyDriverTripStopped(supabaseUrl, serviceRoleKey, driverIdEarly, {
        tripId: trip_id,
        stopReason: "passenger_cancelled",
        cancelledBy: cancelledByRole,
        body: "Rider cancelled this trip",
      });
    };

    const notifyCustomerCancelledIfNeeded = () => {
      const passengerId =
        typeof trip.passenger_id === "string" ? trip.passenger_id : null;
      if (!passengerId) return;
      void notifyCustomerTripLifecycle(supabase, {
        passengerId,
        tripId: trip_id,
        event: "trip_cancelled",
      }).catch((e) =>
        console.warn("[late-cancellation-check] customer trip_cancelled push failed:", e)
      );
    };

    // Already cancelled — still ping driver so active trip UI clears
    if (trip.status === "cancelled" || trip.status === "canceled") {
      await notifyDriverIfAssigned();
      return successResponse({
        success: true,
        fee_applied: false,
        reason: "Trip already cancelled",
        trip_id,
      });
    }

    // No driver assigned → nothing to charge
    if (!trip.driver_id && !trip.confirmed_driver_id) {
      return successResponse({ success: true, fee_applied: false, reason: "No driver assigned" });
    }

    // PRIORITY 1: no-show already applied → never stack
    if ((trip.no_show_charge_pence ?? 0) > 0) {
      return successResponse({
        success: true,
        fee_applied: false,
        reason: "No-show charge already applied (priority 1)",
      });
    }

    // Already terminal (and not awaiting cancellation processing)
    if (trip.completed_at || ["completed", "expired", "declined"].includes(trip.status)) {
      return successResponse({ success: true, fee_applied: false, reason: "Trip already terminal" });
    }

    // Fetch settings (cancellation fee + late cancel)
    const selectCols =
      "late_cancel_enabled, late_cancel_threshold_minutes, late_cancel_fee_pence, cancellation_fee_after_grace_pence, pickup_waiting_grace_period_seconds";
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

    const lateEnabled = settings?.late_cancel_enabled ?? false;
    const thresholdMinutes = settings?.late_cancel_threshold_minutes ?? 5;
    const lateFeePence = settings?.late_cancel_fee_pence ?? 500;
    const cancellationFeeAfterArrival = settings?.cancellation_fee_after_grace_pence ?? 500;
    const gracePeriodSec = settings?.pickup_waiting_grace_period_seconds ?? 300;

    const nowIso = new Date().toISOString();
    const driverId = trip.driver_id || trip.confirmed_driver_id;

    // PRIORITY 2: cancellation after driver has arrived → cancellation fee
    // (overrides waiting charges; clears them so customer is not double-charged)
    if (trip.arrived_at) {
      const arrivedAt = new Date(trip.arrived_at).getTime();
      const elapsedSec = Math.floor((Date.now() - arrivedAt) / 1000);

      // After grace period → full cancellation fee
      // Within grace period → still arrived, charge cancellation fee
      const feePence = cancellationFeeAfterArrival;

      // After-arrival here is not Late Passenger Cancellation and does not
      // check free-wait arrival eligibility. Do not stamp late_cancel_fee_pence
      // or a canonical chargeable outcome. cancel-trip owns arrival settlement.
      const cancelled = await cancelTripRow({
        status: "cancelled",
        cancelled_at: nowIso,
        cancelled_by,
        cancel_reason: elapsedSec >= gracePeriodSec ? "cancelled_after_grace" : "cancelled_after_arrival",
        cancellation_fee_pence: feePence,
        ...preservedDriver,
        pickup_waiting_charge_pence: 0,
        total_waiting_charge_pence: 0,
        updated_at: nowIso,
      });
      if (!cancelled) return terminalConflict();

      if (driverId) {
        await supabase
          .from("drivers")
          .update({ current_trip_id: null, updated_at: nowIso })
          .eq("id", driverId);
      }

      await notifyDriverIfAssigned();
      notifyCustomerCancelledIfNeeded();

      console.log("[late-cancellation-check] Cancellation-after-arrival fee:", feePence, "trip:", trip_id);
      return successResponse({
        success: true,
        fee_applied: true,
        fee_type: "cancellation_after_arrival",
        cancellation_fee_pence: feePence,
        trip_id,
      });
    }

    // PRIORITY 3: pre-arrival late cancellation
    if (!lateEnabled) {
      // Disabled — just cancel without fee (don't double-update if already cancelled)
      if (trip.status !== "cancelled") {
        const cancelled = await cancelTripRow({
          status: "cancelled",
          cancelled_at: nowIso,
          cancelled_by,
          cancel_reason: "passenger_cancelled",
          updated_at: nowIso,
          ...preservedDriver,
        });
        if (!cancelled) return terminalConflict();
        if (driverId) {
          await supabase
            .from("drivers")
            .update({ current_trip_id: null, updated_at: nowIso })
            .eq("id", driverId);
        }
        await notifyDriverIfAssigned();
        notifyCustomerCancelledIfNeeded();
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
      // Cancel without fee
      if (trip.status !== "cancelled") {
        const cancelled = await cancelTripRow({
          status: "cancelled",
          cancelled_at: nowIso,
          cancelled_by,
          cancel_reason: "passenger_cancelled",
          updated_at: nowIso,
          ...preservedDriver,
        });
        if (!cancelled) return terminalConflict();
        if (driverId) {
          await supabase
            .from("drivers")
            .update({ current_trip_id: null, updated_at: nowIso })
            .eq("id", driverId);
        }
        await notifyDriverIfAssigned();
        notifyCustomerCancelledIfNeeded();
      }
      return successResponse({ success: true, fee_applied: false, reason: "Not within late cancellation window" });
    }

    // Apply late-cancel fee
    const lateCancelled = await cancelTripRow({
      status: "cancelled",
      cancelled_at: nowIso,
      cancelled_by,
      cancel_reason: "late_cancellation",
      late_cancel_fee_pence: lateFeePence,
      financial_outcome: "LATE_PASSENGER_CANCELLATION",
      updated_at: nowIso,
      ...preservedDriver,
    });
    if (!lateCancelled) return terminalConflict();

    if (driverIdEarly) {
      try {
        await maybeResumeTerminalFeeSettlementAfterProviderFee(supabase, {
          tripId: trip_id,
          source: "late-cancellation-check",
        });
      } catch (settleErr) {
        console.error("[late-cancellation-check] terminal settlement error:", settleErr);
      }
    }

    if (driverId) {
      await supabase
        .from("drivers")
        .update({ current_trip_id: null, updated_at: nowIso })
        .eq("id", driverId);
    }

    await notifyDriverIfAssigned();
    notifyCustomerCancelledIfNeeded();

    console.log("[late-cancellation-check] Late-cancel fee:", lateFeePence, "trip:", trip_id);

    return successResponse({
      success: true,
      fee_applied: true,
      fee_type: "late_cancellation",
      late_cancel_fee_pence: lateFeePence,
      trip_id,
    });
  } catch (err) {
    console.error("[late-cancellation-check] Error:", err);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
