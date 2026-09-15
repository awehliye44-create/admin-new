import { createClient } from "npm:@supabase/supabase-js@2.57.2";

import {
  customerSearchExpiresAtIso,
  loadDispatchSettings,
} from "../_shared/dispatch-settings.ts";
import { rebroadcastTripViaAutoDispatch } from "../_shared/dispatchOrchestrator.ts";
import {
  isScheduledInstantConversionPending,
  isScheduledWorkflowOrigin,
} from "../_shared/scheduledHandoverHoldLock.ts";
import {
  buildClearTripAssignmentPatch,
  resolveNextRematchBroadcastRound,
  getTripAssignedDriverId,
  logTripAssignedDriverFieldResolved,
  TRIP_CANCEL_REMATCH_SELECT,
} from "../_shared/driverCancelRematch.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabaseAuth.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = claimsData.claims.sub as string;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json() as { tripId?: string; retry?: boolean };
    if (!body?.tripId) {
      return new Response(JSON.stringify({ error: "tripId is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: customer } = await supabase
      .from("customers")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();

    if (!customer) {
      return new Response(JSON.stringify({ error: "Customer not found" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logTripAssignedDriverFieldResolved("customer-resume-driver-search");

    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select(TRIP_CANCEL_REMATCH_SELECT)
      .eq("id", body.tripId)
      .maybeSingle();

    if (tripErr || !trip) {
      return new Response(JSON.stringify({ error: "Trip not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (trip.passenger_id !== customer.id) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tripStatus = String(trip.status ?? "").toLowerCase();
    const isLegacyDriverCancelShape =
      tripStatus === "cancelled"
      && (trip.cancel_reason === "driver_cancelled" || trip.cancelled_by === "driver");
    const terminalNoResume = new Set([
      "customer_cancelled",
      "customer_canceled",
      "expired",
      "expired_no_driver",
      "no_show",
      "completed",
      "failed",
    ]);
    if (terminalNoResume.has(tripStatus)) {
      console.log("[customer-resume-driver-search] TERMINAL_TRIP_NO_RESUME", {
        trip_id: body.tripId,
        status: trip.status,
      });
      return new Response(
        JSON.stringify({ ok: false, error: "Trip has ended", status: trip.status }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (tripStatus === "cancelled" && !isLegacyDriverCancelShape) {
      console.log("[customer-resume-driver-search] TERMINAL_DRIVER_CANCEL_NO_REMATCH", {
        trip_id: body.tripId,
        status: trip.status,
        cancel_reason: trip.cancel_reason ?? null,
        cancelled_by: trip.cancelled_by ?? null,
      });
      return new Response(
        JSON.stringify({ ok: false, error: "Trip cancelled — no rematch cycle", status: trip.status }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const dispatchSettings = await loadDispatchSettings(supabase, trip.service_area_id);
    const handoverPending = isScheduledInstantConversionPending(trip);
    const defaultSearchingExpiresAt = handoverPending
      ? null
      : customerSearchExpiresAtIso(dispatchSettings);

    const isExpiredRetry =
      body.retry === true &&
      (trip.status === "expired" || trip.status === "expired_no_driver");

    if (isExpiredRetry) {
      await supabase
        .from("ride_offers")
        .update({
          status: "revoked",
          revoked_reason: "customer_retry_search",
          updated_at: new Date().toISOString(),
        })
        .eq("trip_id", body.tripId)
        .in("status", ["pending", "countered", "accepted"]);

      const searchingExpiresAt = defaultSearchingExpiresAt;
      const nowIso = new Date().toISOString();

      const { data: updated, error: updErr } = await supabase
        .from("trips")
        .update({
          status: "searching_new_driver",
          dispatch_status: "broadcasting",
          searching_expires_at: searchingExpiresAt,
          ...buildClearTripAssignmentPatch(),
          negotiation_locked_until: null,
          negotiation_status: null,
          current_negotiation_id: null,
          locked_driver_id: null,
          cancel_reason: null,
          cancelled_by: null,
          updated_at: nowIso,
        })
        .eq("id", body.tripId)
        .in("status", ["expired", "expired_no_driver"])
        .select("id, status, searching_expires_at")
        .maybeSingle();

      if (updErr) {
        console.error("[customer-resume-driver-search] expired retry update:", updErr);
        return new Response(JSON.stringify({ error: updErr.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!updated) {
        return new Response(
          JSON.stringify({ error: "Trip is no longer expired — please refresh" }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      await supabase
        .from("customers")
        .update({ active_trip_id: body.tripId })
        .eq("id", customer.id);

      const dispatchResult = await rebroadcastTripViaAutoDispatch(
        supabase,
        body.tripId,
        "customer_expired_retry_search",
      );
      if (!dispatchResult.ok) {
        console.error("[customer-resume-driver-search] expired retry auto-dispatch:", dispatchResult.error);
      }

      return new Response(
        JSON.stringify({
          ok: true,
          tripId: body.tripId,
          status: updated.status,
          searching_expires_at: updated.searching_expires_at,
          retry: true,
          dispatch_path: dispatchResult.path,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (trip.status === "searching_new_driver") {
      if (!trip.searching_expires_at && !isScheduledWorkflowOrigin(trip)) {
        console.error("[customer-resume-driver-search] FAKE_SEARCH_CYCLE_BLOCKED", {
          trip_id: body.tripId,
          status: trip.status,
          reason: "missing_searching_expires_at",
        });
        return new Response(
          JSON.stringify({
            ok: false,
            error: "No backend search cycle — trip cannot resume searching",
            status: trip.status,
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      await supabase
        .from("customers")
        .update({ active_trip_id: body.tripId })
        .eq("id", customer.id);

      const dispatchResult = await rebroadcastTripViaAutoDispatch(
        supabase,
        body.tripId,
        "customer_resume_search_idempotent",
      );
      if (!dispatchResult.ok) {
        console.error("[customer-resume-driver-search] idempotent auto-dispatch:", dispatchResult.error);
      }
      return new Response(
        JSON.stringify({
          ok: true,
          tripId: body.tripId,
          status: trip.status,
          idempotent: true,
          dispatch_path: dispatchResult.path,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    /**
     * Two valid recovery shapes:
     *  (a) clean: status='driver_cancelled' (driver-cancel-before-pickup endpoint)
     *  (b) legacy: status='cancelled' AND (cancel_reason='driver_cancelled' OR cancelled_by='driver')
     *      (driver app uses generic cancel-trip endpoint — confirmed_driver_id may still be on the row, and
     *       cancelled_driver_ids was not appended). We normalize here.
     */
    const isCleanShape = trip.status === "driver_cancelled";
    const isLegacyShape =
      trip.status === "cancelled" &&
      (trip.cancel_reason === "driver_cancelled" || trip.cancelled_by === "driver");

    if (!isCleanShape && !isLegacyShape) {
      return new Response(
        JSON.stringify({
          error: `Trip is not awaiting recovery (status=${trip.status})`,
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Compute next cancelled_driver_ids: append the cancelling driver so dispatch excludes them.
    const cancellingDriverId = getTripAssignedDriverId(trip);
    const prevCancelled = Array.isArray(trip.cancelled_driver_ids)
      ? (trip.cancelled_driver_ids as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const nextCancelled =
      cancellingDriverId && !prevCancelled.includes(cancellingDriverId)
        ? [...prevCancelled, cancellingDriverId]
        : prevCancelled;

    // Revoke any still-live ride_offers so re-dispatch isn't blocked
    await supabase
      .from("ride_offers")
      .update({
        status: "revoked",
        revoked_reason: "driver_cancelled_before_pickup",
        updated_at: new Date().toISOString(),
      })
      .eq("trip_id", body.tripId)
      .in("status", ["pending", "accepted"]);

    const { data: maxRoundRow } = await supabase
      .from("ride_offers")
      .select("broadcast_round")
      .eq("trip_id", body.tripId)
      .order("broadcast_round", { ascending: false })
      .limit(1)
      .maybeSingle();

    const rematchBroadcastRound = resolveNextRematchBroadcastRound(
      maxRoundRow?.broadcast_round ?? (trip as { current_broadcast_round?: number }).current_broadcast_round ?? 0,
    );

    const prevExcluded = Array.isArray((trip as { excluded_driver_ids?: string[] }).excluded_driver_ids)
      ? (trip as { excluded_driver_ids: string[] }).excluded_driver_ids.filter(
        (x): x is string => typeof x === "string",
      )
      : [];
    const nextExcluded = [...new Set([...prevExcluded, ...nextCancelled])];

    const searchingExpiresAt = defaultSearchingExpiresAt;
    const nowIso = new Date().toISOString();

    const updateBuilder = supabase
      .from("trips")
      .update({
        status: "searching_new_driver",
        searching_expires_at: searchingExpiresAt,
        current_broadcast_round: rematchBroadcastRound,
        ...buildClearTripAssignmentPatch(),
        scheduled_accepted_at: null,
        cancelled_driver_ids: nextCancelled,
        excluded_driver_ids: nextExcluded,
        cancel_reason: null,
        cancelled_by: null,
        updated_at: nowIso,
      })
      .eq("id", body.tripId)
      .eq("status", trip.status);

    const { data: updated, error: updErr } = await updateBuilder
      .select("id, status, searching_expires_at")
      .maybeSingle();

    if (updErr) {
      console.error("[customer-resume-driver-search] update:", updErr);
      return new Response(JSON.stringify({ error: updErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!updated) {
      return new Response(
        JSON.stringify({ error: "Trip state changed — please refresh" }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    await supabase
      .from("customers")
      .update({ active_trip_id: body.tripId })
      .eq("id", customer.id);

    const dispatchResult = await rebroadcastTripViaAutoDispatch(
      supabase,
      body.tripId,
      "customer_resume_after_driver_cancel",
    );
    if (!dispatchResult.ok) {
      console.error("[customer-resume-driver-search] auto-dispatch:", dispatchResult.error);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        tripId: body.tripId,
        status: updated.status,
        searching_expires_at: updated.searching_expires_at,
        dispatch_path: dispatchResult.path,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: unknown) {
    console.error("[customer-resume-driver-search]", e);
    const message = e instanceof Error ? e.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
