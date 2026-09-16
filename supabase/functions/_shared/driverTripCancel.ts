/**
 * Driver terminal trip cancel — SSOT for post-pickup / in-progress driver cancellation.
 * Pre-pickup rematch uses driver-cancel-before-pickup (not this module).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  buildClearTripAssignmentPatch,
  isPrePickupDriverRematchEligibleDbStatus,
} from "./driverCancelRematch.ts";
import { isTripAtPickupStatus } from "./pickupWaiting.ts";
import { sanitizeString } from "./security.ts";
import { notifyCustomerTripLifecycle } from "./customerTripLifecycleNotify.ts";
import {
  handleQueuedTripAfterCurrentTripFailure,
  handleQueuedTripDriverCancel,
} from "./stackedRideLifecycle.ts";

export type DriverCancelResult =
  | { ok: true; action: "driver_cancel" | "cancel_queued_stacked"; detail?: Record<string, unknown> }
  | { ok: false; code: string; message: string; status: number };

const CANCEL_SETTINGS_SELECT =
  "pickup_waiting_grace_period_seconds, cancellation_fee_after_grace_pence, late_cancel_enabled, late_cancel_threshold_minutes, late_cancel_fee_pence";

async function loadCancelSettings(
  supabase: SupabaseClient,
  serviceAreaId: string | null | undefined,
): Promise<Record<string, unknown> | null> {
  if (serviceAreaId) {
    const { data } = await supabase
      .from("dispatch_settings")
      .select(CANCEL_SETTINGS_SELECT)
      .eq("service_area_id", serviceAreaId)
      .maybeSingle();
    if (data) return data as Record<string, unknown>;
  }
  const { data } = await supabase
    .from("dispatch_settings")
    .select(CANCEL_SETTINGS_SELECT)
    .is("service_area_id", null)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

export async function executeDriverQueuedStackedCancel(
  supabase: SupabaseClient,
  tripId: string,
  driverId: string,
): Promise<DriverCancelResult> {
  const releaseResult = await handleQueuedTripDriverCancel(supabase, tripId, driverId);
  return {
    ok: true,
    action: "cancel_queued_stacked",
    detail: releaseResult as unknown as Record<string, unknown>,
  };
}

export async function executeDriverTerminalCancel(
  supabase: SupabaseClient,
  input: {
    tripId: string;
    driverId: string;
    cancelReason: string;
    rawStatus: string;
    trip: Record<string, unknown>;
  },
): Promise<DriverCancelResult> {
  const { tripId, driverId, cancelReason, rawStatus, trip } = input;
  const trimmedReason = cancelReason?.trim();
  if (!trimmedReason) {
    return { ok: false, code: "REASON_REQUIRED", message: "Cancellation reason is required", status: 400 };
  }

  if (rawStatus === "queued") {
    return executeDriverQueuedStackedCancel(supabase, tripId, driverId);
  }

  if (isPrePickupDriverRematchEligibleDbStatus(rawStatus)) {
    return {
      ok: false,
      code: "USE_DRIVER_CANCEL_REMATCH",
      message: "Pre-pickup driver cancel must use driver-cancel-before-pickup (rematch, not terminal cancel)",
      status: 400,
    };
  }

  const terminalBlocked = new Set(["completed", "cancelled", "declined", "expired"]);
  if (terminalBlocked.has(rawStatus)) {
    return {
      ok: false,
      code: "TRIP_TERMINAL",
      message: `Trip is terminal (${rawStatus}); cancel is not allowed`,
      status: 409,
    };
  }

  const now = new Date().toISOString();
  // Preserve the outgoing driver reference so the driver app can still receive
  // Realtime events and SELECT this row after driver_id/confirmed_driver_id
  // are cleared — RLS uses previous_driver_id to grant read access on terminal trips.
  const previousDriverId =
    (trip as { confirmed_driver_id?: string | null }).confirmed_driver_id ??
    (trip as { driver_id?: string | null }).driver_id ??
    null;
  const updateData: Record<string, unknown> = {
    status: "cancelled",
    cancelled_at: now,
    cancelled_by: "driver",
    cancel_reason: sanitizeString(trimmedReason, 200),
    dispatch_status: "cancelled",
    updated_at: now,
    previous_driver_id: previousDriverId,
    ...buildClearTripAssignmentPatch(),
    special_instructions: `[CANCELLED: ${sanitizeString(trimmedReason, 200)}] ${String(trip.special_instructions ?? "")}`,
  };

  const cancelSettings = await loadCancelSettings(
    supabase,
    typeof trip.service_area_id === "string" ? trip.service_area_id : null,
  );

  const arrivedAt = typeof trip.arrived_at === "string" ? trip.arrived_at : null;
  if (isTripAtPickupStatus(rawStatus) && arrivedAt) {
    const gracePeriodSec = Number(cancelSettings?.pickup_waiting_grace_period_seconds ?? 300);
    const cancelFeePence = Number(cancelSettings?.cancellation_fee_after_grace_pence ?? 500);
    const elapsedSec = Math.floor((Date.now() - new Date(arrivedAt).getTime()) / 1000);
    if (elapsedSec >= gracePeriodSec && cancelFeePence > 0) {
      updateData.cancellation_fee_pence = cancelFeePence;
      updateData.grace_period_expired_at = trip.grace_period_expired_at ?? now;
    }
  }

  const isPassengerCancel = ["passenger_requested", "late_cancellation", "passenger_no_show"].includes(
    trimmedReason,
  );
  const lateCancelEnabled = Boolean(cancelSettings?.late_cancel_enabled ?? false);
  if (isPassengerCancel && lateCancelEnabled && trip.driver_id) {
    const thresholdMin = Number(cancelSettings?.late_cancel_threshold_minutes ?? 5);
    const lateCancelFeePence = Number(cancelSettings?.late_cancel_fee_pence ?? 500);
    let isLate = false;
    if (trip.is_scheduled && trip.scheduled_at) {
      const scheduledAt = new Date(String(trip.scheduled_at)).getTime();
      isLate = (scheduledAt - Date.now()) / (1000 * 60) <= thresholdMin;
    } else if (trip.accepted_at) {
      const acceptedAt = new Date(String(trip.accepted_at)).getTime();
      isLate = (Date.now() - acceptedAt) / (1000 * 60) >= thresholdMin;
    }
    if (isLate && lateCancelFeePence > 0) {
      updateData.late_cancel_fee_pence = lateCancelFeePence;
    }
  }

  const pickupWaiting = Number(trip.pickup_waiting_charge_pence ?? 0);
  if (pickupWaiting > 0) {
    updateData.pickup_waiting_charge_pence = pickupWaiting;
  }

  const { data: updatedTrip, error: updateError } = await supabase
    .from("trips")
    .update(updateData)
    .eq("id", tripId)
    .eq("status", rawStatus)
    .select()
    .maybeSingle();

  if (updateError) {
    if (updateError.code === "PGRST116") {
      return {
        ok: false,
        code: "CONFLICT",
        message: "Trip status changed - please refresh and try again",
        status: 409,
      };
    }
    return { ok: false, code: "UPDATE_FAILED", message: "Failed to cancel trip", status: 500 };
  }

  if (!updatedTrip) {
    return {
      ok: false,
      code: "CONFLICT",
      message: "Trip status changed during cancel - please refresh",
      status: 409,
    };
  }

  await supabase
    .from("ride_offers")
    .update({
      status: "revoked",
      revoked_reason: "driver_terminal_cancel",
      updated_at: now,
    })
    .eq("trip_id", tripId)
    .eq("driver_id", driverId)
    .in("status", ["pending", "accepted", "countered"]);

  await supabase
    .from("drivers")
    .update({ current_trip_id: null, updated_at: now })
    .eq("id", driverId);

  await handleQueuedTripAfterCurrentTripFailure(supabase, {
    currentTripId: tripId,
    driverId,
    failureReason: "driver_cancel_terminal",
  });

  // Terminal driver cancel — dispose payment (no fee for driver-initiated; rematch path is separate).
  try {
    const { disposeTerminalTripPayment } = await import("./terminalTripPaymentDisposition.ts");
    await disposeTerminalTripPayment(supabase, {
      tripId,
      reason: "driver_cancel_terminal",
    });
  } catch (e) {
    console.error("[driverTripCancel] payment disposition failed (sweep will retry)", e);
  }

  console.log("[driverTripCancel] DRIVER_CANCEL_SUCCESS", JSON.stringify({
    trip_id: tripId,
    driver_id: driverId,
    raw_status: rawStatus,
    source: "stop-workflow:driver_cancel",
  }));

  const passengerId =
    typeof trip.passenger_id === "string" ? trip.passenger_id : null;
  await notifyCustomerTripLifecycle(supabase, {
    passengerId,
    tripId,
    event: "trip_cancelled",
  });

  return { ok: true, action: "driver_cancel", detail: { trip_id: tripId } };
}
