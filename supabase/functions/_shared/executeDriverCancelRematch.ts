/**
 * Driver cancel before start → rematch (customer trip survives).
 * Shared by driver-cancel-before-pickup Edge and stop-workflow driver_cancel.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  customerSearchExpiresAtIso,
  customerSearchWindowMs,
  loadDispatchSettings,
} from "./dispatch-settings.ts";
import { rebroadcastTripViaAutoDispatch } from "./dispatchOrchestrator.ts";
import { handleQueuedTripAfterCurrentTripFailure } from "./stackedRideLifecycle.ts";
import {
  buildClearTripAssignmentPatch,
  buildDriverCancelRematchBroadcastPatch,
  buildSearchCycleId,
  isDriverAssignedToTrip,
  isPrePickupDriverRematchEligibleDbStatus,
  logTripAssignedDriverFieldResolved,
  PRE_PICKUP_DRIVER_REMATCH_DB_STATUSES,
  resolveNextRematchBroadcastRound,
  TRIP_ASSIGNED_DRIVER_COLUMN,
  TRIP_CANCEL_REMATCH_SELECT,
} from "./driverCancelRematch.ts";
import { resolveCancellationOutcome } from "./cancellationOutcome.ts";

export type DriverCancelRematchResult =
  | {
      ok: true;
      action: "driver_cancel_rematch";
      detail: Record<string, unknown>;
    }
  | { ok: false; code: string; message: string; status: number };

/**
 * Apply pre-start driver cancel → searching_new_driver rematch.
 * Excludes cancelling driver; rebroadcasts via auto-dispatch (unless scan_go).
 */
export async function executeDriverCancelBeforePickupRematch(
  supabase: SupabaseClient,
  input: {
    tripId: string;
    driverId: string;
    /** Required cancellation reason from the Driver CTA. */
    reason?: string | null;
    /** Optional preloaded trip row (must include rematch select fields). */
    trip?: Record<string, unknown> | null;
    source?: string;
  },
): Promise<DriverCancelRematchResult> {
  const { tripId, driverId } = input;
  const source = input.source ?? "executeDriverCancelBeforePickupRematch";
  const cancelReason =
    typeof input.reason === "string" && input.reason.trim()
      ? input.reason.trim().slice(0, 200)
      : "driver_cancelled";

  logTripAssignedDriverFieldResolved(source);

  let trip = input.trip ?? null;
  if (!trip) {
    const { data, error } = await supabase
      .from("trips")
      .select(TRIP_CANCEL_REMATCH_SELECT)
      .eq("id", tripId)
      .maybeSingle();
    if (error || !data) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: error?.message ?? "Trip not found",
        status: 404,
      };
    }
    trip = data as Record<string, unknown>;
  }

  const rawStatus = String(trip.status ?? "").trim().toLowerCase();
  const outcome = resolveCancellationOutcome({
    actor: "driver",
    status: rawStatus,
    startedAt: typeof trip.started_at === "string" ? trip.started_at : null,
    arrivedAt: typeof trip.arrived_at === "string" ? trip.arrived_at : null,
    dispatchStatus: typeof trip.dispatch_status === "string" ? trip.dispatch_status : null,
    isNoShow: false,
    driverId,
    confirmedDriverId:
      typeof trip.confirmed_driver_id === "string" ? trip.confirmed_driver_id : null,
  });

  if (outcome.kind === "reject") {
    return {
      ok: false,
      code: outcome.error_code ?? "INVALID_STATE",
      message: outcome.reason ?? `Cannot cancel as driver in status: ${rawStatus}`,
      status: 400,
    };
  }

  if (outcome.kind !== "rematch") {
    return {
      ok: false,
      code: "USE_TERMINAL_CANCEL",
      message: "Pre-pickup rematch not applicable — use terminal cancel path",
      status: 400,
    };
  }

  if (!isPrePickupDriverRematchEligibleDbStatus(rawStatus)) {
    return {
      ok: false,
      code: "INVALID_STATE",
      message: `Cannot cancel as driver in status: ${rawStatus}`,
      status: 400,
    };
  }

  if (!trip.confirmed_driver_id) {
    return {
      ok: false,
      code: "INVALID_STATE",
      message: "Trip has no assigned driver — cannot rematch",
      status: 409,
    };
  }

  if (!isDriverAssignedToTrip(
    { confirmed_driver_id: trip.confirmed_driver_id as string | null },
    driverId,
  )) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Not assigned to this trip",
      status: 403,
    };
  }

  const prevCancelled = Array.isArray(trip.cancelled_driver_ids)
    ? (trip.cancelled_driver_ids as unknown[]).filter(
      (x): x is string => typeof x === "string",
    )
    : [];
  const nextCancelled = prevCancelled.includes(driverId)
    ? prevCancelled
    : [...prevCancelled, driverId];

  const nowIso = new Date().toISOString();

  const { error: revokeOffersError } = await supabase
    .from("ride_offers")
    .update({
      status: "revoked",
      revoked_reason: "driver_cancelled_before_pickup",
      updated_at: nowIso,
    })
    .eq("trip_id", tripId)
    .in("status", ["pending", "accepted"]);

  if (revokeOffersError) {
    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message: revokeOffersError.message,
      status: 500,
    };
  }

  const serviceAreaId =
    typeof trip.service_area_id === "string" ? trip.service_area_id : null;
  const dispatchSettings = await loadDispatchSettings(supabase, serviceAreaId);
  const { data: maxRoundRow } = await supabase
    .from("ride_offers")
    .select("broadcast_round")
    .eq("trip_id", tripId)
    .order("broadcast_round", { ascending: false })
    .limit(1)
    .maybeSingle();

  const rematchBroadcastRound = resolveNextRematchBroadcastRound(
    (maxRoundRow as { broadcast_round?: number } | null)?.broadcast_round ??
      (typeof trip.current_broadcast_round === "number"
        ? trip.current_broadcast_round
        : 0),
  );

  const prevExcluded = Array.isArray(trip.excluded_driver_ids)
    ? (trip.excluded_driver_ids as unknown[]).filter(
      (x): x is string => typeof x === "string",
    )
    : [];
  const nextExcluded = [...new Set([...prevExcluded, ...nextCancelled])];

  const searchingExpiresAt = customerSearchExpiresAtIso(dispatchSettings);
  const searchWindowMs = customerSearchWindowMs(dispatchSettings);
  const searchCycleId = buildSearchCycleId(
    tripId,
    rematchBroadcastRound,
    searchingExpiresAt,
  );

  // Production rematch: status=searching_new_driver, dispatch_status=broadcasting
  const { data: updatedTrip, error: tripUpdateError } = await supabase
    .from("trips")
    .update({
      status: "searching_new_driver",
      dispatch_status: "broadcasting",
      ...buildClearTripAssignmentPatch(),
      ...buildDriverCancelRematchBroadcastPatch(),
      cancelled_driver_ids: nextCancelled,
      excluded_driver_ids: nextExcluded,
      scheduled_accepted_at: null,
      cancelled_by: "driver",
      cancel_reason: cancelReason,
      current_broadcast_round: rematchBroadcastRound,
      searching_expires_at: searchingExpiresAt,
      updated_at: nowIso,
    })
    .eq("id", tripId)
    .eq(TRIP_ASSIGNED_DRIVER_COLUMN, driverId)
    .select("id, status, searching_expires_at, current_broadcast_round, dispatch_status")
    .maybeSingle();

  if (tripUpdateError || !updatedTrip) {
    return {
      ok: false,
      code: "CONFLICT",
      message:
        tripUpdateError?.message ??
        "Trip assignment changed — refresh and try again",
      status: 409,
    };
  }

  await supabase
    .from("drivers")
    .update({ current_trip_id: null })
    .eq("id", driverId)
    .eq("current_trip_id", tripId);

  if (typeof trip.passenger_id === "string" && trip.passenger_id) {
    await supabase
      .from("customers")
      .update({ active_trip_id: tripId })
      .eq("id", trip.passenger_id);
  }

  const isScanGo = trip.scan_go === true;
  if (isScanGo) {
    await supabase
      .from("trips")
      .update({
        status: "expired",
        dispatch_status: "expired",
        cancel_reason: "scan_go_driver_unavailable",
        updated_at: new Date().toISOString(),
      })
      .eq("id", tripId);
  } else {
    const dispatchResult = await rebroadcastTripViaAutoDispatch(
      supabase,
      tripId,
      "driver_cancel_before_pickup",
    );
    if (!dispatchResult.ok) {
      console.error(
        `[${source}] auto-dispatch:`,
        dispatchResult.error,
      );
    }
  }

  if (typeof trip.stacked_trip_id === "string" && trip.stacked_trip_id) {
    await handleQueuedTripAfterCurrentTripFailure(supabase, {
      currentTripId: tripId,
      driverId,
      failureReason: "driver_cancel_before_pickup",
    });
  }

  // Scan&Go expire is terminal — dispose payment. Rematch keeps the authorisation.
  if (isScanGo) {
    try {
      const { disposeTerminalTripPayment } = await import("./terminalTripPaymentDisposition.ts");
      await disposeTerminalTripPayment(supabase, {
        tripId,
        reason: "driver_cancel_terminal",
      });
    } catch (e) {
      console.error("[executeDriverCancelRematch] scan_go payment disposition failed", e);
    }
  }

  return {
    ok: true,
    action: "driver_cancel_rematch",
    detail: {
      tripId,
      status: isScanGo ? "expired" : "searching_new_driver",
      scan_go: isScanGo,
      reason: isScanGo ? "scan_go_driver_unavailable" : undefined,
      searching_expires_at: isScanGo ? null : searchingExpiresAt,
      search_window_ms: isScanGo ? null : searchWindowMs,
      search_cycle_id: isScanGo ? null : searchCycleId,
      current_broadcast_round: isScanGo ? null : rematchBroadcastRound,
      cancelled_driver_ids: nextCancelled,
      allowed_pre_pickup_statuses: PRE_PICKUP_DRIVER_REMATCH_DB_STATUSES,
      lifecycle_outcome: outcome.kind,
    },
  };
}
