import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  customerSearchExpiresAtIso,
  customerSearchWindowMs,
  loadDispatchSettings,
} from "../_shared/dispatch-settings.ts";
import { rebroadcastTripViaAutoDispatch } from "../_shared/dispatchOrchestrator.ts";
import { handleQueuedTripAfterCurrentTripFailure } from "../_shared/stackedRideLifecycle.ts";
import {
  buildClearTripAssignmentPatch,
  buildDriverCancelRematchBroadcastPatch,
  buildSearchCycleId,
  resolveNextRematchBroadcastRound,
  isDriverAssignedToTrip,
  isPrePickupDriverRematchEligibleDbStatus,
  logTripAssignedDriverFieldResolved,
  PRE_PICKUP_DRIVER_REMATCH_DB_STATUSES,
  TRIP_ASSIGNED_DRIVER_COLUMN,
  TRIP_CANCEL_REMATCH_SELECT,
} from "../_shared/driverCancelRematch.ts";
import {
  handleCORSPreflight,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";

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
    };
    const tripId =
      (typeof rawBody.tripId === "string" && rawBody.tripId.trim()) ||
      (typeof rawBody.trip_id === "string" && rawBody.trip_id.trim()) ||
      "";
    if (!tripId) {
      return errorResponse("VALIDATION", "Missing tripId", 400);
    }
    // Keep local alias used throughout this handler.
    const body = { ...rawBody, tripId };

    console.log("DRIVER_CANCEL_PATH_ENTERED", JSON.stringify({
      trip_id: body.tripId,
      actor: "driver",
      edge: "driver-cancel-before-pickup",
    }));

    console.log("DRIVER_CANCEL_REQUESTED", JSON.stringify({
      trip_id: body.tripId,
      actor: "driver",
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
      .select(TRIP_CANCEL_REMATCH_SELECT)
      .eq("id", body.tripId)
      .maybeSingle();

    if (tripError || !trip) {
      console.error("[driver-cancel-before-pickup] trip lookup failed", tripError);
      return errorResponse("NOT_FOUND", "Trip not found", 404);
    }

    const assignedDriverId = trip.confirmed_driver_id;
    if (!assignedDriverId) {
      console.error("[driver-cancel-before-pickup] missing assignment field", {
        trip_id: body.tripId,
        field: TRIP_ASSIGNED_DRIVER_COLUMN,
      });
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
        redirect: "no_terminal_driver_cancel_use_no_show_if_passenger_no_show",
      }));
      return errorResponse(
        "INVALID_STATE",
        `Cannot cancel as driver in status: ${trip.status}`,
        400,
      );
    }

    console.log("DRIVER_CANCELLED_AFTER_ACCEPT_CONFIRMED", JSON.stringify({
      trip_id: body.tripId,
      driver_id: driver.id,
      prev_status: trip.status,
    }));
    console.log("DRIVER_CANCEL_REMATCH_REUSED", JSON.stringify({
      trip_id: body.tripId,
      workflow: "driver-cancel-before-pickup",
      rebroadcast: "rebroadcastTripViaAutoDispatch",
    }));
    console.log("DRIVER_CANCEL_REUSE_EXISTING_REMATCH_WORKFLOW", JSON.stringify({
      trip_id: body.tripId,
      workflow: "driver-cancel-before-pickup",
    }));
    console.log("DRIVER_CANCEL_REMATCH_STARTED", JSON.stringify({
      trip_id: body.tripId,
    }));
    console.log("DRIVER_CANCEL_SAME_RIDE_ID_KEPT", JSON.stringify({
      trip_id: body.tripId,
    }));

    const prevCancelled = Array.isArray(trip.cancelled_driver_ids)
      ? trip.cancelled_driver_ids.filter((x): x is string => typeof x === "string")
      : [];
    const nextCancelled = prevCancelled.includes(driver.id)
      ? prevCancelled
      : [...prevCancelled, driver.id];

    const nowIso = new Date().toISOString();

    const { error: revokeOffersError } = await supabase
      .from("ride_offers")
      .update({
        status: "revoked",
        revoked_reason: "driver_cancelled_before_pickup",
        updated_at: nowIso,
      })
      .eq("trip_id", body.tripId)
      .in("status", ["pending", "accepted"]);

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

    const prevExcluded = Array.isArray((trip as { excluded_driver_ids?: string[] }).excluded_driver_ids)
      ? (trip as { excluded_driver_ids: string[] }).excluded_driver_ids.filter(
        (x): x is string => typeof x === "string",
      )
      : [];
    const nextExcluded = [...new Set([...prevExcluded, ...nextCancelled])];

    const searchingExpiresAt = customerSearchExpiresAtIso(dispatchSettings);
    const searchWindowMs = customerSearchWindowMs(dispatchSettings);
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
    console.log("DRIVER_CANCEL_TERMINAL_BLOCKED_BEFORE_START", JSON.stringify({
      trip_id: body.tripId,
      status: rawStatus,
      rematch: true,
    }));
    const searchCycleId = buildSearchCycleId(body.tripId, rematchBroadcastRound, searchingExpiresAt);

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
        cancel_reason: "driver_cancelled",
        current_broadcast_round: rematchBroadcastRound,
        searching_expires_at: searchingExpiresAt,
        updated_at: nowIso,
      })
      .eq("id", body.tripId)
      .eq(TRIP_ASSIGNED_DRIVER_COLUMN, driver.id)
      .select("id, status, searching_expires_at, current_broadcast_round, dispatch_status")
      .maybeSingle();

    if (tripUpdateError || !updatedTrip) {
      console.error("[driver-cancel-before-pickup] trip update:", tripUpdateError);
      return errorResponse(
        "CONFLICT",
        tripUpdateError?.message ?? "Trip assignment changed — refresh and try again",
        409,
      );
    }

    console.log("DRIVER_CANCEL_NEW_SEARCH_CYCLE_CREATED", JSON.stringify({
      trip_id: body.tripId,
      search_cycle_id: searchCycleId,
      current_broadcast_round: updatedTrip.current_broadcast_round ?? 0,
      status: updatedTrip.status,
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
      cancelled_driver_ids: nextCancelled,
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

    // Scan & Go retired — always rematch ordinary pre-pickup cancel.
    const dispatchResult = await rebroadcastTripViaAutoDispatch(
      supabase,
      body.tripId,
      "driver_cancel_before_pickup",
    );
    console.log("DRIVER_CANCEL_MATCHING_TRIGGERED", JSON.stringify({
      trip_id: body.tripId,
      search_cycle_id: searchCycleId,
      ok: dispatchResult.ok,
      path: dispatchResult.path,
      error: dispatchResult.error ?? null,
    }));
    if (!dispatchResult.ok) {
      console.error("[driver-cancel-before-pickup] auto-dispatch:", dispatchResult.error);
    }

    if ((trip as { stacked_trip_id?: string | null }).stacked_trip_id) {
      await handleQueuedTripAfterCurrentTripFailure(supabase, {
        currentTripId: body.tripId,
        driverId: driver.id,
        failureReason: "driver_cancel_before_pickup",
      });
    }

    return successResponse({
      success: true,
      tripId: body.tripId,
      trip_id: body.tripId,
      status: "searching_new_driver",
      outcome: "rematch",
      searching_expires_at: searchingExpiresAt,
      search_cycle_id: searchCycleId,
      current_broadcast_round: rematchBroadcastRound,
    });
  } catch (e: unknown) {
    console.error("[driver-cancel-before-pickup]", e);
    const message = e instanceof Error ? e.message : "Unknown error";
    return errorResponse("INTERNAL_ERROR", message, 500);
  }
});
