import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  releaseRevolutPreauthForTrip,
  resolveRevolutOrderIdFromTrip,
} from "../_shared/revolutPreauthReleaseSSOT.ts";
import { isScheduledInstantConversionPending } from "../_shared/scheduledHandoverHoldLock.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Authenticate the caller
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabaseAuth.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = claimsData.claims.sub;
    
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { tripId } = await req.json();

    if (!tripId) {
      console.error("Missing tripId");
      return new Response(
        JSON.stringify({ error: "tripId is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Expiring trip ${tripId} - no driver found`);

    // Fetch the trip to verify it's still in a searchable state.
    // Scan & Go retired (trips.scan_go dropped 20260903121500) — do not SELECT it.
    const { data: trip, error: fetchError } = await supabase
      .from("trips")
      .select("id, status, driver_id, passenger_id, provider_order_id, payment_provider, payment_status, service_area_id, broadcast_enabled, dispatch_mode, scheduled_status, negotiation_owner_driver_id, negotiation_status, negotiation_disabled, searching_expires_at, current_broadcast_round, max_broadcast_rounds")
      .eq("id", tripId)
      .maybeSingle();

    if (fetchError) {
      console.error("Error fetching trip:", fetchError);
      return new Response(
        JSON.stringify({ error: "Failed to fetch trip" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!trip) {
      console.log("Trip not found:", tripId);
      return new Response(
        JSON.stringify({ error: "Trip not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify the caller owns this trip
    const { data: customer } = await supabase
      .from("customers")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();

    if (!customer || trip.passenger_id !== customer.id) {
      console.log("User does not own this trip");
      return new Response(
        JSON.stringify({ error: "Forbidden — you do not own this trip" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (isScheduledInstantConversionPending(trip)) {
      console.log(`[expire-trip] Refusing marketplace expire — scheduled handover pending`, {
        tripId,
        status: trip.status,
        dispatch_mode: trip.dispatch_mode,
        scheduled_status: trip.scheduled_status,
      });
      return new Response(
        JSON.stringify({
          success: false,
          search_active: true,
          message: "Scheduled handover pending; instant search TTL not started",
          status: trip.status,
          dispatch_mode: trip.dispatch_mode,
          scheduled_status: trip.scheduled_status,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const searchingExpiresMs = trip.searching_expires_at
      ? new Date(trip.searching_expires_at).getTime()
      : null;
    const searchWindowElapsed =
      searchingExpiresMs != null
      && Number.isFinite(searchingExpiresMs)
      && Date.now() >= searchingExpiresMs;

    // Locked-driver trips (retired Scan & Go used dispatch_mode=locked_driver) — refuse marketplace expire.
    if (trip.dispatch_mode === "locked_driver") {
      console.log(`[expire-trip] Refusing marketplace expire for locked_driver trip ${tripId}`);
      return new Response(
        JSON.stringify({
          message: "Locked-driver trips cannot be expired via marketplace search timeout",
          status: trip.status,
          dispatch_mode: "locked_driver",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // broadcast_enabled=false during negotiation/rematch blocks dispatch only while the window is open.
    if (trip.broadcast_enabled === false && !searchWindowElapsed) {
      console.log(`[expire-trip] Refusing expire — broadcast paused and search window still open`, {
        tripId,
        status: trip.status,
        searching_expires_at: trip.searching_expires_at,
      });
      return new Response(
        JSON.stringify({
          success: false,
          search_active: true,
          message: "Driver search window still open",
          status: trip.status,
          searching_expires_at: trip.searching_expires_at,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Never expire during active fare negotiation (locked driver, no marketplace rebroadcast).
    const tripNegStatus = (trip as { negotiation_status?: string | null }).negotiation_status;
    const negotiationOwnerId = (trip as { negotiation_owner_driver_id?: string | null }).negotiation_owner_driver_id;
    const negotiationDisabled = (trip as { negotiation_disabled?: boolean }).negotiation_disabled === true;
    if (
      trip.status === "negotiating"
      || (negotiationOwnerId && tripNegStatus !== "failed" && !negotiationDisabled)
    ) {
      console.log(`[expire-trip] Refusing expire — active negotiation`, {
        tripId,
        status: trip.status,
        negotiation_status: tripNegStatus,
        negotiation_owner_driver_id: negotiationOwnerId,
      });
      return new Response(
        JSON.stringify({
          message: "Trip is in active fare negotiation — cannot expire via marketplace search",
          status: trip.status,
          negotiation_status: tripNegStatus,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Only expire if still in searching states and no driver assigned
    const searchingStates = [
      "pending",
      "searching",
      "offered",
      "broadcasting",
      "offering",
      "searching_new_driver",
    ];
    if (!searchingStates.includes(trip.status) || trip.driver_id) {
      console.log(`Trip ${tripId} is not in a searchable state or has a driver assigned. Status: ${trip.status}, Driver: ${trip.driver_id}`);
      return new Response(
        JSON.stringify({ 
          message: "Trip is no longer searchable or has a driver assigned",
          status: trip.status,
          driverId: trip.driver_id 
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: expiredByServer, error: updateError } = await supabase.rpc(
      "expire_trip_when_search_exhausted",
      { p_trip_id: tripId },
    );

    if (updateError) {
      console.error("Error updating trip to expired:", updateError);
      return new Response(
        JSON.stringify({ error: "Failed to expire trip" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (expiredByServer !== true) {
      const { data: currentTrip } = await supabase
        .from("trips")
        .select("status, dispatch_status, current_broadcast_round, max_broadcast_rounds, searching_expires_at")
        .eq("id", tripId)
        .maybeSingle();

      const expiresMs = currentTrip?.searching_expires_at
        ? new Date(currentTrip.searching_expires_at).getTime()
        : null;
      if (expiresMs != null && Number.isFinite(expiresMs) && Date.now() >= expiresMs) {
        console.log("STALE_SEARCHING_TRIP_FOUND", {
          trip_id: tripId,
          status: currentTrip?.status ?? trip.status,
          searching_expires_at: currentTrip?.searching_expires_at ?? null,
        });
      }

      console.log(`[expire-trip] Search still active for ${tripId}`, currentTrip);
      return new Response(
        JSON.stringify({
          success: false,
          search_active: true,
          message: "Driver search is still active",
          tripId,
          status: currentTrip?.status ?? trip.status,
          dispatch_status: currentTrip?.dispatch_status,
          current_broadcast_round: currentTrip?.current_broadcast_round ?? trip.current_broadcast_round,
          max_broadcast_rounds: currentTrip?.max_broadcast_rounds ?? trip.max_broadcast_rounds,
          searching_expires_at: currentTrip?.searching_expires_at ?? trip.searching_expires_at,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Release Revolut preauth hold when no driver assigned ──
    const revolutOrderId = resolveRevolutOrderIdFromTrip(trip as Record<string, unknown>);
    if (revolutOrderId) {
      try {
        const revolutRelease = await releaseRevolutPreauthForTrip(supabase, {
          tripId,
          providerOrderId: revolutOrderId,
          reason: "no_driver_assigned",
          stage: "expire_trip",
          feePence: 0,
        });
        console.log(`[PAYMENT_AUDIT] expire-trip Revolut hold`, {
          trip_id: tripId,
          provider_order_id: revolutOrderId,
          ...revolutRelease,
        });
      } catch (revolutErr) {
        console.error("[PAYMENT_AUDIT] expire-trip Revolut release failed (non-fatal):", revolutErr);
      }
    }

    // Legacy non-Revolut hold-release branch permanently removed.
    // Revolut release above is the sole expire-trip hold path (MK-260813-003 baseline).

    // Revoke any pending ride offers for this trip
    const { error: revokeError } = await supabase
      .from("ride_offers")
      .update({ status: "revoked", revoked_reason: "trip_expired", updated_at: new Date().toISOString() })
      .eq("trip_id", tripId)
      .eq("status", "pending");

    if (revokeError) {
      console.warn("Failed to revoke pending offers:", revokeError);
    }

    // Clear the customer's active_trip_id
    if (trip.passenger_id) {
      const { error: customerError } = await supabase
        .from("customers")
        .update({ active_trip_id: null })
        .eq("id", trip.passenger_id);

      if (customerError) {
        console.warn("Failed to clear customer active_trip_id:", customerError);
      }
    }

    console.log("SEARCH_CYCLE_EXPIRED_BACKEND", { trip_id: tripId });
    console.log("TRIP_MARKED_EXPIRED_NO_DRIVER", { trip_id: tripId });
    console.log(`Trip ${tripId} expired successfully - no driver available`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: "Trip expired - no driver available",
        tripId 
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Unexpected error in expire-trip:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
