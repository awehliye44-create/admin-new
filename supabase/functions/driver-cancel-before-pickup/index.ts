import {
  buildRematchPickupWaitingResetPatch,
  closeAllOpenWaitingSegmentsForTrip,
} from "../_shared/waitingSegmentClock.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  customerSearchExpiresAtIso,
  customerSearchWindowMs,
  loadDispatchSettings,
  maxBroadcastSequences,
} from "../_shared/dispatch-settings.ts";
import { rebroadcastTripViaAutoDispatch } from "../_shared/dispatchOrchestrator.ts";
import { handleQueuedTripAfterCurrentTripFailure } from "../_shared/stackedRideLifecycle.ts";
import {
  buildSearchCycleId,
  resolveNextRematchBroadcastRound,
  classifyTripLookupFailure,
  isDriverAssignedToTrip,
  isIdempotentDriverRematchReplay,
  isPrePickupDriverRematchEligibleDbStatus,
  logTripAssignedDriverFieldResolved,
  PRE_PICKUP_DRIVER_REMATCH_DB_STATUSES,
  TRIP_ASSIGNED_DRIVER_COLUMN,
  TRIP_CANCEL_REMATCH_SELECT,
} from "../_shared/driverCancelRematch.ts";
import {
  buildInstantOriginDriverCancelRematchPatch,
  buildScheduledOriginDriverCancelRematchPatch,
  DRIVER_CANCEL_REMATCH_CAS_STATUSES,
  isAccidentOrBreakdownCancelReason,
  normalizeDriverCancelReason,
  shouldConvertScheduledOriginOnDriverCancel,
} from "../_shared/scheduledDriverCancelRematchSSOT.ts";
import {
  handleCORSPreflight,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import { notifyCustomerTripLifecycle } from "../_shared/customerTripLifecycleNotify.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return errorResponse("UNAUTHORIZED", "Unauthorized", 401);
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: authError } = await supabase.auth.getUser(token);

    if (authError || !userData?.user) {
      return errorResponse("UNAUTHORIZED", "Unauthorized", 401);
    }

    const rawBody = await req.json() as {
      tripId?: string;
      trip_id?: string;
      reason?: string;
      cancel_reason?: string;
    };
    const tripId =
      (typeof rawBody.tripId === "string" && rawBody.tripId.trim()) ||
      (typeof rawBody.trip_id === "string" && rawBody.trip_id.trim()) ||
      "";
    if (!tripId) {
      return errorResponse("VALIDATION", "Missing tripId", 400);
    }
    const body = { ...rawBody, tripId };
    const cancelReason = normalizeDriverCancelReason(
      rawBody.reason ?? rawBody.cancel_reason,
    );

    console.log("DRIVER_CANCEL_PATH_ENTERED", JSON.stringify({
      trip_id: body.tripId,
      actor: "driver",
      edge: "driver-cancel-before-pickup",
    }));

    console.log("DRIVER_CANCEL_REQUESTED", JSON.stringify({
      trip_id: body.tripId,
      actor: "driver",
      cancel_reason: cancelReason,
    }));

    const { data: driver, error: driverError } = await supabase
      .from("drivers")
      .select("id, user_id")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (driverError || !driver) {
      return errorResponse("FORBIDDEN", "Driver not found", 403);
    }

    console.log("DRIVER_CANCEL_ACTOR_CONFIRMED_DRIVER", JSON.stringify({
      trip_id: body.tripId,
      driver_id: driver.id,
    }));
    console.log("DRIVER_CANCEL_NO_SHOW_FALSE", JSON.stringify({
      trip_id: body.tripId,
      path: "driver-cancel-before-pickup",
    }));
    logTripAssignedDriverFieldResolved("driver-cancel-before-pickup");

    const { data: trip, error: tripError } = await supabase
      .from("trips")
      .select(
        `${TRIP_CANCEL_REMATCH_SELECT}, started_at, scheduled_ack_status, broadcast_enabled, previous_driver_id, pickup_waiting_started_at`,
      )
      .eq("id", body.tripId)
      .maybeSingle();

    if (tripError) {
      const classified = classifyTripLookupFailure(tripError);
      console.error("[driver-cancel-before-pickup] trip lookup failed", {
        trip_id: body.tripId,
        kind: classified?.kind ?? "internal",
        code: tripError.code ?? null,
        message: tripError.message ?? null,
      });
      return errorResponse(
        classified?.error ?? "INTERNAL_ERROR",
        classified?.message ?? "Trip lookup failed",
        classified?.httpStatus ?? 500,
      );
    }
    if (!trip) {
      return errorResponse("NOT_FOUND", "Trip not found", 404);
    }

    if (isIdempotentDriverRematchReplay({
      status: trip.status,
      driverId: driver.id,
      cancelledDriverIds: trip.cancelled_driver_ids,
      excludedDriverIds: trip.excluded_driver_ids,
    })) {
      console.log("DRIVER_CANCEL_REMATCH_IDEMPOTENT", JSON.stringify({
        trip_id: body.tripId,
        driver_id: driver.id,
        status: trip.status,
      }));
      return successResponse({
        success: true,
        idempotent: true,
        tripId: body.tripId,
        trip_id: body.tripId,
        status: "searching_new_driver",
        outcome: "rematch",
      });
    }

    const assignedDriverId = trip.confirmed_driver_id;
    if (!assignedDriverId) {
      return errorResponse(
        "INVALID_STATE",
        "Trip has no assigned driver — cannot rematch",
        409,
      );
    }

    if (!isDriverAssignedToTrip(trip, driver.id)) {
      return errorResponse("FORBIDDEN", "Not assigned to this trip", 403);
    }

    if (!isPrePickupDriverRematchEligibleDbStatus(trip.status)) {
      console.log("DRIVER_CANCEL_TERMINAL_CLEAR_BLOCKED", JSON.stringify({
        trip_id: body.tripId,
        reason: "status_not_pre_pickup_rematch",
        status: trip.status,
        allowed: PRE_PICKUP_DRIVER_REMATCH_DB_STATUSES,
      }));
      return errorResponse(
        "INVALID_STATE",
        `Cannot cancel as driver in status: ${trip.status}`,
        400,
      );
    }

    if (trip.started_at) {
      return errorResponse(
        "INVALID_STATE",
        "Trip has already started — use in-progress cancel",
        409,
      );
    }

    const nowIso = new Date().toISOString();

    const { error: revokeOffersError } = await supabase
      .from("ride_offers")
      .update({
        status: "revoked",
        revoked_reason: "driver_cancelled_before_pickup",
        updated_at: nowIso,
      })
      .eq("trip_id", body.tripId)
      .in("status", ["pending", "accepted", "offered", "countered"]);

    if (revokeOffersError) {
      console.error("[driver-cancel-before-pickup] revoke offers:", revokeOffersError);
      return errorResponse("INTERNAL_ERROR", revokeOffersError.message, 500);
    }

    const dispatchSettings = await loadDispatchSettings(supabase, trip.service_area_id);
    const { data: maxRoundRow } = await supabase
      .from("ride_offers")
      .select("broadcast_round")
      .eq("trip_id", body.tripId)
      .order("broadcast_round", { ascending: false })
      .limit(1)
      .maybeSingle();

    const rematchBroadcastRound = resolveNextRematchBroadcastRound(
      maxRoundRow?.broadcast_round ?? trip.current_broadcast_round ?? 0,
    );

    const convertScheduled = shouldConvertScheduledOriginOnDriverCancel(trip);

    let searchingExpiresAt: string | null;
    let searchWindowMs: number;
    let patch: Record<string, unknown>;

    if (convertScheduled) {
      const { data: gds } = await supabase
        .from("global_dispatch_settings")
        .select("max_driver_find_time_minutes, max_dispatch_rounds")
        .eq("singleton", true)
        .maybeSingle();
      const maxFind = Math.max(
        1,
        Number(gds?.max_driver_find_time_minutes ?? 6) || 6,
      );
      searchingExpiresAt = new Date(Date.now() + maxFind * 60_000).toISOString();
      searchWindowMs = maxFind * 60_000;
      const instantMaxSequences = maxBroadcastSequences(
        { max_dispatch_rounds: gds?.max_dispatch_rounds },
        null,
      );
      patch = buildScheduledOriginDriverCancelRematchPatch({
        nowIso,
        searchingExpiresAtIso: searchingExpiresAt,
        maxExistingBroadcastRound: Number(maxRoundRow?.broadcast_round ?? 0) || 0,
        maxBroadcastSequences: instantMaxSequences,
        excludeDriverId: driver.id,
        existingExcludedDriverIds: trip.excluded_driver_ids,
        existingCancelledDriverIds: trip.cancelled_driver_ids,
        currentBroadcastEnabled: (trip as { broadcast_enabled?: boolean | null })
          .broadcast_enabled,
        cancelReason,
      });
      console.log("DRIVER_CANCEL_SCHEDULED_ORIGIN_CONVERTED", JSON.stringify({
        trip_id: body.tripId,
        dispatch_mode: "instant",
        scheduled_status: "converted_to_instant",
        searching_expires_at: searchingExpiresAt,
        max_find_minutes: maxFind,
      }));
    } else {
      searchingExpiresAt = customerSearchExpiresAtIso(dispatchSettings);
      searchWindowMs = customerSearchWindowMs(dispatchSettings);
      patch = buildInstantOriginDriverCancelRematchPatch({
        nowIso,
        searchingExpiresAtIso: searchingExpiresAt,
        rematchBroadcastRound,
        excludeDriverId: driver.id,
        existingExcludedDriverIds: trip.excluded_driver_ids,
        existingCancelledDriverIds: trip.cancelled_driver_ids,
        cancelReason,
      });
    }

    const rawStatus = String(trip.status ?? "").trim().toLowerCase();
    const arrivedBeforeStartStatuses = new Set([
      "arrived",
      "arrived_pickup",
      "arrived_at_pickup",
      "at_pickup",
      "pickup_waiting",
      "waiting",
      "driver_arrived",
      "waiting_at_pickup",
    ]);
    if (arrivedBeforeStartStatuses.has(rawStatus)) {
      console.log("DRIVER_CANCEL_AFTER_ARRIVE_BEFORE_START_REMATCH", JSON.stringify({
        trip_id: body.tripId,
        status: rawStatus,
      }));
    } else {
      console.log("DRIVER_CANCEL_BEFORE_START_REMATCH", JSON.stringify({
        trip_id: body.tripId,
        status: rawStatus,
      }));
    }

    const searchCycleId = buildSearchCycleId(
      body.tripId,
      Number(patch.current_broadcast_round ?? rematchBroadcastRound) || 0,
      searchingExpiresAt,
    );

    // Atomic ownership CAS: assignment + pre-start status + not started.
    let updateQuery = supabase
      .from("trips")
      .update(patch)
      .eq("id", body.tripId)
      .eq(TRIP_ASSIGNED_DRIVER_COLUMN, driver.id)
      .in("status", [...DRIVER_CANCEL_REMATCH_CAS_STATUSES])
      .is("started_at", null);

    const { data: updatedTrip, error: tripUpdateError } = await updateQuery
      .select("id, status, searching_expires_at, current_broadcast_round, dispatch_status, dispatch_mode, scheduled_status")
      .maybeSingle();

    if (tripUpdateError || !updatedTrip) {
      console.error("[driver-cancel-before-pickup] trip update CAS miss:", tripUpdateError);
      return errorResponse(
        "CONFLICT",
        tripUpdateError?.message ??
          "Trip assignment or status changed — refresh and try again",
        409,
      );
    }

    // Rematch must not let the next driver inherit the cancelled driver's pickup
    // waiting clock (open segment / arrived_at). scheduled_at is NOT touched, so
    // the D4 eligible floor still applies to the replacement driver's Arrived.
    // Best-effort, after the ownership CAS: a reset failure never blocks the rematch.
    if (arrivedBeforeStartStatuses.has(rawStatus) || trip.pickup_waiting_started_at) {
      await closeAllOpenWaitingSegmentsForTrip(supabase, body.tripId, nowIso);
      const { error: waitResetErr } = await supabase
        .from("trips")
        .update(buildRematchPickupWaitingResetPatch(nowIso))
        .eq("id", body.tripId)
        .is("driver_id", null)
        .is("started_at", null);
      if (waitResetErr) {
        console.warn("[driver-cancel-before-pickup] rematch waiting reset failed", waitResetErr.message);
      }
    }

    console.log("DRIVER_CANCEL_NEW_SEARCH_CYCLE_CREATED", JSON.stringify({
      trip_id: body.tripId,
      search_cycle_id: searchCycleId,
      current_broadcast_round: updatedTrip.current_broadcast_round ?? 0,
      status: updatedTrip.status,
      dispatch_mode: updatedTrip.dispatch_mode,
      scheduled_status: updatedTrip.scheduled_status,
      searching_expires_at: updatedTrip.searching_expires_at,
    }));
    console.log("DRIVER_CANCEL_COUNTDOWN_RESET_180", JSON.stringify({
      trip_id: body.tripId,
      searching_expires_at: searchingExpiresAt,
      search_window_ms: searchWindowMs,
      search_cycle_id: searchCycleId,
    }));
    console.log("DRIVER_CANCELLED_DRIVER_EXCLUDED", JSON.stringify({
      trip_id: body.tripId,
      driver_id: driver.id,
    }));

    await supabase.from("drivers").update({ current_trip_id: null }).eq("id", driver.id).eq(
      "current_trip_id",
      body.tripId,
    );

    if (trip.passenger_id) {
      await supabase
        .from("customers")
        .update({ active_trip_id: body.tripId })
        .eq("id", trip.passenger_id);
    }

    void notifyCustomerTripLifecycle(supabase, {
      passengerId: typeof trip.passenger_id === "string" ? trip.passenger_id : null,
      tripId: body.tripId,
      event: "driver_cancelled",
      title: "ONECAB DRIVER CANCELLED",
      body: "We're finding another driver for you.",
      notificationId: `driver_cancelled-${body.tripId}-${searchCycleId}`,
    }).catch((e) =>
      console.warn("[driver-cancel-before-pickup] customer driver_cancelled push failed:", e)
    );

    if (isAccidentOrBreakdownCancelReason(cancelReason)) {
      const fingerprint = `driver_cancel_incident:${body.tripId}:${driver.id}`;
      try {
        await supabase.from("ops_alerts").upsert(
          {
            fingerprint,
            title: "Driver cancelled — accident/breakdown (pre-start rematch)",
            related_trip_id: body.tripId,
            metadata: {
              trip_id: body.tripId,
              driver_id: driver.id,
              cancel_reason: cancelReason,
              outcome: "rematch",
            },
            status: "open",
            updated_at: nowIso,
          },
          { onConflict: "fingerprint" },
        );
      } catch (opsErr) {
        console.warn("[driver-cancel-before-pickup] ops_alert upsert failed", opsErr);
      }
    }

    const dispatchResult = await rebroadcastTripViaAutoDispatch(
      supabase,
      body.tripId,
      "driver_cancel_before_pickup",
    );

    console.log("DRIVER_CANCEL_REMATCH_DISPATCH", JSON.stringify({
      trip_id: body.tripId,
      ok: dispatchResult.ok,
      path: dispatchResult.path,
      error: dispatchResult.error ?? null,
      dispatch_mode: updatedTrip.dispatch_mode,
      scheduled_status: updatedTrip.scheduled_status,
    }));

    if (trip.stacked_trip_id) {
      try {
        await handleQueuedTripAfterCurrentTripFailure(supabase, {
          tripId: body.tripId,
          stackedTripId: trip.stacked_trip_id,
          reason: "driver_cancel_before_pickup",
        });
      } catch (stackErr) {
        console.warn("[driver-cancel-before-pickup] stacked follow-up failed", stackErr);
      }
    }

    return successResponse({
      success: true,
      tripId: body.tripId,
      trip_id: body.tripId,
      status: "searching_new_driver",
      outcome: "rematch",
      searching_expires_at: searchingExpiresAt,
      dispatch_mode: updatedTrip.dispatch_mode,
      scheduled_status: updatedTrip.scheduled_status,
      dispatch: dispatchResult,
      cancel_reason: cancelReason,
    });
  } catch (error) {
    console.error("[driver-cancel-before-pickup] Error:", error);
    return errorResponse(
      "INTERNAL_ERROR",
      error instanceof Error ? error.message : "Unknown error",
      500,
    );
  }
});
