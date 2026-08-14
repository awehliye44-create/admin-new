import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  securityHeaders,
  jsonHeaders,
  handleCORSPreflight,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  isValidUUID,
  validationErrorResponse,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import {
  assertCanAcceptOfferByDriverId,
  driverNotEligibleResponse,
  logDriverEligibilityBlocked,
} from "../_shared/driverEligibility.ts";
import { recordDispatchWaveSnapshot } from "../_shared/recordDispatchWaveSnapshot.ts";
import {
  loadStackedRideConfig,
  logStackedRideDisabledSafeGuard,
  STACKED_RIDE_DISABLED_SAFE_GUARD,
} from "../_shared/stackedRideConfig.ts";
import { resolveDriverActiveTripId } from "../_shared/activeDriverTripGuard.ts";
import { STACKED_RIDE_STATES } from "../_shared/stackedRideState.ts";
import {
  logRequestDuration,
  startRequestTimer,
  withDuration,
  createRequestId,
  finishEdgeRequestLog,
} from "../_shared/edgeRequestTiming.ts";
import { requireAuthenticatedUser } from "../_shared/edgeAuth.ts";

interface AcceptRequest {
  offer_id: string;
  driver_id: string;
  is_stacked?: boolean;
  current_trip_id?: string;
}

// Rate limit config: 30 requests per minute per IP (accept actions should be limited)
const RATE_LIMIT_CONFIG = { limit: 30, windowMs: 60000, keyPrefix: 'accept-offer' };

/** Business-rule failure — HTTP 200 so Capacitor clients read JSON instead of transport errors. */
function businessFailureResponse(
  error: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return successResponse({ success: false, error, message, ...extra });
}

/**
 * Fire-and-forget RIDE_STOP push to dismiss native notification on driver's device.
 */
async function sendRideStopPush(
  supabaseUrl: string,
  serviceKey: string,
  driverId: string,
  reason: string,
  ids?: { offer_id?: string; trip_id?: string },
) {
  const data: Record<string, string> = {
    stopReason: reason,
    stop_reason: reason,
  };
  if (ids?.offer_id) {
    data.offer_id = ids.offer_id;
    data.offerId = ids.offer_id;
  }
  if (ids?.trip_id) {
    data.trip_id = ids.trip_id;
    data.tripId = ids.trip_id;
    data.booking_id = ids.trip_id;
    data.bookingId = ids.trip_id;
  }

  const resp = await fetch(`${supabaseUrl}/functions/v1/send-driver-notification`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      driverId,
      type: "RIDE_STOP",
      title: "Ride Update",
      body: reason === "accepted" ? "Ride accepted" : "Ride no longer available",
      data,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    console.warn(`[accept-offer] RIDE_STOP push response ${resp.status}: ${errText}`);
  }
}

/**
 * Accept Offer Edge Function
 * 
 * Uses database-level advisory locks to prevent race conditions.
 * Only ONE driver can successfully accept a ride - all others get rejected.
 * 
 * Security features:
 * - JWT authentication (driver identity derived from token)
 * - Rate limiting (30 req/min per IP)
 * - Input validation (UUID format)
 * - Security headers
 */
Deno.serve(async (req) => {
  const elapsed = startRequestTimer();
  const requestId = createRequestId();
  console.log("[accept-offer] Received request:", req.method);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  // Rate limiting
  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    console.log("[accept-offer] Rate limited:", clientIP);
    return rateLimitResponse(rateLimitResult);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // ── Authenticate caller ──
    const auth = await requireAuthenticatedUser(req, supabaseUrl, anonKey);
    if (!auth.ok) return auth.response;
    const userId = auth.userId;

    // Resolve driver_id from authenticated user
    const { data: authDriver, error: authDriverErr } = await supabase
      .from("drivers")
      .select("id")
      .eq("user_id", userId)
      .single();

    if (authDriverErr || !authDriver) {
      return errorResponse("UNAUTHORIZED", "No driver profile found for authenticated user", 403);
    }

    const authenticatedDriverId = authDriver.id;

    const body: AcceptRequest = await req.json();
    const { offer_id, is_stacked, current_trip_id } = body;

    // Use authenticated driver_id, reject if body driver_id doesn't match
    if (body.driver_id && body.driver_id !== authenticatedDriverId) {
      console.error("[accept-offer] driver_id mismatch: body=", body.driver_id, "auth=", authenticatedDriverId);
      return errorResponse("FORBIDDEN", "driver_id does not match authenticated user", 403);
    }

    const driver_id = authenticatedDriverId;

    const acceptEligibility = await assertCanAcceptOfferByDriverId(supabase, driver_id);
    if (!acceptEligibility.allowed) {
      logDriverEligibilityBlocked("accept-offer", driver_id, acceptEligibility);
      return driverNotEligibleResponse(acceptEligibility, jsonHeaders);
    }

    console.log("[accept-offer] Processing:", { offer_id, driver_id, is_stacked, current_trip_id });

    // Input validation
    const validationErrors: Record<string, string> = {};
    
    if (!offer_id) {
      validationErrors.offer_id = "offer_id is required";
    } else if (!isValidUUID(offer_id)) {
      validationErrors.offer_id = "offer_id must be a valid UUID";
    }
    
    if (current_trip_id && !isValidUUID(current_trip_id)) {
      validationErrors.current_trip_id = "current_trip_id must be a valid UUID";
    }
    
    if (Object.keys(validationErrors).length > 0) {
      return validationErrorResponse(validationErrors);
    }

    // Single ride_offers fetch — covers stacked path (expires_at, broadcast_round)
    // and normal path (is_urgent_dispatch, negotiation fields). Eliminates two
    // duplicate SELECTs that previously ran further down both code paths.
    const { data: pendingOffer } = await supabase
      .from("ride_offers")
      .select(
        "trip_id, status, is_stacked, expires_at, broadcast_round, " +
        "is_urgent_dispatch, negotiation_status, driver_offer_fare, customer_counter_fare",
      )
      .eq("id", offer_id)
      .eq("driver_id", driver_id)
      .maybeSingle();

    // Pre-hold: another driver must not accept (or stacked-queue) a trip owned
    // by the negotiating driver. Backend SSOT is trips.negotiation_owner_driver_id.
    if (pendingOffer?.trip_id) {
      const { data: holdTrip } = await supabase
        .from("trips")
        .select("status, negotiation_owner_driver_id")
        .eq("id", pendingOffer.trip_id)
        .maybeSingle();
      const ownerId =
        (holdTrip as { negotiation_owner_driver_id?: string | null } | null)
          ?.negotiation_owner_driver_id ?? null;
      const tripStatus = String(holdTrip?.status ?? "");
      if (
        (ownerId && ownerId !== driver_id) ||
        (tripStatus === "negotiating" && ownerId !== driver_id)
      ) {
        console.log("[accept-offer] BLOCKED_NEGOTIATION_HELD", {
          offer_id,
          driver_id,
          owner_driver_id: ownerId,
          trip_status: tripStatus,
        });
        return businessFailureResponse(
          "NEGOTIATION_HELD",
          "This trip is held for another driver",
          { trip_id: pendingOffer.trip_id, owner_driver_id: ownerId },
        );
      }
    }

    let effectiveIsStacked = Boolean(is_stacked);
    let effectiveCurrentTripId = current_trip_id ?? null;

    const activeTripId = await resolveDriverActiveTripId(supabase, driver_id);
    if (
      activeTripId &&
      pendingOffer?.trip_id &&
      activeTripId !== pendingOffer.trip_id &&
      pendingOffer.status === "pending"
    ) {
      if (!effectiveIsStacked) {
        console.log("[accept-offer] STACKED_RIDE_AUTO_REDIRECT", {
          driver_id,
          active_trip_id: activeTripId,
          offer_trip_id: pendingOffer.trip_id,
          lifecycle: STACKED_RIDE_STATES.stacked_waiting_current_trip_completion,
        });
        effectiveIsStacked = true;
        effectiveCurrentTripId = activeTripId;
      }
    }

    // Stacked rides queue as next trip only — never activate immediately.
    if (effectiveIsStacked) {
      if (!effectiveCurrentTripId) {
        return businessFailureResponse(
          "MISSING_CURRENT_TRIP",
          "current_trip_id is required to queue a stacked ride",
        );
      }

      console.log("[accept-offer] Processing stacked ride acceptance (atomic RPC)");

      // Single atomic RPC — validates, writes offer+queued trip+link in one transaction.
      // Error codes surface as PostgreSQL exception messages caught below.
      const { data: stackedResult, error: stackedRpcErr } = await supabase.rpc(
        "accept_stacked_ride",
        {
          p_offer_id:         offer_id,
          p_driver_id:        driver_id,
          p_current_trip_id:  effectiveCurrentTripId,
        },
      );

      if (stackedRpcErr) {
        const msg = String(stackedRpcErr.message ?? stackedRpcErr);
        console.error("[accept-offer] accept_stacked_ride RPC error:", msg);

        // Map PostgreSQL exception tokens → client-facing codes
        if (msg.includes("offer_not_found"))          return businessFailureResponse("OFFER_NOT_FOUND",       "Stacked offer not found");
        if (msg.includes("offer_not_for_driver"))     return businessFailureResponse("OFFER_FORBIDDEN",       "This offer does not belong to you");
        if (msg.includes("offer_not_pending"))        return businessFailureResponse("OFFER_NOT_PENDING",     `Offer already ${msg.split("::").pop()}`);
        if (msg.includes("offer_expired"))            return businessFailureResponse("OFFER_EXPIRED",         "Offer has expired");
        if (msg.includes("NEGOTIATION_HELD"))         return businessFailureResponse("NEGOTIATION_HELD",      "This trip is held for another driver");
        if (msg.includes("stacked_rides_disabled"))   {
          // Re-log the safe-guard token so ops can see it
          console.log(STACKED_RIDE_DISABLED_SAFE_GUARD, { offer_id, driver_id, phase: "stacked_accept_rpc_blocked" });
          return businessFailureResponse(STACKED_RIDE_DISABLED_SAFE_GUARD, "Stacked rides are disabled");
        }
        if (msg.includes("current_trip_not_found"))   return businessFailureResponse("CURRENT_TRIP_NOT_FOUND",  "Active trip not found — cannot queue stacked ride");
        if (msg.includes("current_trip_not_yours"))   return businessFailureResponse("CURRENT_TRIP_FORBIDDEN",  "You are not the driver on the current active trip");
        if (msg.includes("current_trip_terminal"))    return businessFailureResponse("CURRENT_TRIP_NOT_ACTIVE", "Current trip is no longer active — accept the stacked ride as a normal offer");
        if (msg.includes("already_has_stacked_trip")) return businessFailureResponse("ALREADY_HAS_STACKED_TRIP","Current trip already has a queued stacked ride");
        if (msg.includes("queued_trip_assign_failed"))return businessFailureResponse("DATABASE_ERROR",          "Failed to assign queued trip");
        if (msg.includes("link_failed"))              return businessFailureResponse("DATABASE_ERROR",          "Failed to link stacked trip to active trip");

        return businessFailureResponse("DATABASE_ERROR", msg);
      }

      const rpc = stackedResult as {
        success: boolean;
        trip_id: string;
        current_trip_id: string;
        revoked_driver_ids: string[];
        passenger_user_id: string | null;
      };

      const acceptedTripId = rpc.trip_id;
      const revokedDriverIds: string[] = rpc.revoked_driver_ids ?? [];
      const passengerUserId: string | null = rpc.passenger_user_id ?? null;

      // ── Push: dismiss notification on accepting driver ────────────────────────
      sendRideStopPush(supabaseUrl, supabaseKey, driver_id, "accepted", {
        offer_id,
        trip_id: acceptedTripId,
      }).catch(e => console.error("[accept-offer] RIDE_STOP push error (self):", e));

      // ── Push: dismiss notifications on revoked drivers ────────────────────────
      for (const revokedDriverId of revokedDriverIds) {
        sendRideStopPush(supabaseUrl, supabaseKey, revokedDriverId, "accepted_other", {
          trip_id: acceptedTripId,
        }).catch(e => console.error("[accept-offer] RIDE_STOP push error (revoked):", e));
      }

      // ── Push: notify customer that driver is completing a nearby trip first ───
      if (passengerUserId) {
        supabase.functions.invoke("send-customer-notification", {
          body: {
            customer_id: passengerUserId,
            type:        "stacked_driver_assigned",
            title:       "Driver assigned",
            body:        "Your driver is completing a nearby trip first. We'll keep you updated.",
            data: {
              trip_id:          acceptedTripId,
              current_trip_id:  effectiveCurrentTripId,
              stacked:          "true",
            },
          },
        }).catch(e => console.warn("[accept-offer] customer stacked push failed:", e));
      } else {
        console.warn("[accept-offer] stacked accept: passenger_user_id not found — customer push skipped", {
          trip_id: acceptedTripId,
          current_trip_id: effectiveCurrentTripId,
        });
      }

      console.log("[accept-offer] Stacked ride accepted (atomic):", acceptedTripId);
      console.log("STACKED_RIDE_FARE_ISOLATION_CHECK", {
        trip_id: acceptedTripId,
        current_trip_id: effectiveCurrentTripId,
        fare_source: "stacked_ride",
        note: "fare/wallet unchanged — observability stub only",
      });

      const offer = pendingOffer;
      const { error: acceptedLogErr } = await supabase.rpc("record_booking_delivery", {
        p_booking_id: acceptedTripId,
        p_phase:      "accepted",
        p_driver_id:  driver_id,
        p_offer_id:   offer_id,
        p_source:     "edge_accept_offer",
        p_detail: {
          accepted_via:     "stacked_accept",
          current_trip_id:  effectiveCurrentTripId,
          is_stacked:       true,
        },
      });
      if (acceptedLogErr) {
        console.warn("[accept-offer] record_booking_delivery(accepted, stacked) failed:", acceptedLogErr);
      }

      await recordDispatchWaveSnapshot(supabase, {
        tripId:         acceptedTripId,
        dispatchRound:  Math.max(1, offer?.broadcast_round ?? 1),
        stage:          "selected",
        driverId:       driver_id,
        rideOfferId:    offer_id,
        source:         "stacked_accept",
        metadata: {
          stacked_accept:  true,
          current_trip_id: effectiveCurrentTripId,
          accepted_via:    "stacked_accept",
        },
      });

      const duration_ms = elapsed();
      logRequestDuration("accept-offer", duration_ms, {
        request_id: requestId,
        path:    "stacked_accept",
        offer_id,
        trip_id: acceptedTripId,
      });
      finishEdgeRequestLog("accept-offer", duration_ms, {
        request_id: requestId,
        trip_id: acceptedTripId,
        offer_id,
        path: "stacked_accept",
      });
      return successResponse(withDuration({
        success:    true,
        trip_id:    acceptedTripId,
        is_stacked: true,
        message:    "Stacked ride accepted - will start after current trip",
      }, duration_ms, { source: "accept-offer", requestId }));
    }

    // Reuse pendingOffer fetched at the start — all needed fields already present
    const offerRow = pendingOffer;

    if (offerRow) {
      const ns = String(offerRow.negotiation_status ?? "").toLowerCase();
      const driverOfferFare = Number(offerRow.driver_offer_fare ?? 0);
      if (
        ns === "waiting_customer"
        && driverOfferFare > 0
        && offerRow.status !== "accepted"
      ) {
        console.log("[accept-offer] BLOCKED_NEGOTIATION_PENDING_CUSTOMER", {
          offer_id,
          driver_id,
          negotiation_status: ns,
          driver_offer_fare: driverOfferFare,
        });
        return businessFailureResponse(
          "NEGOTIATION_PENDING_CUSTOMER",
          "Customer must accept or decline your fare offer before you can accept this ride",
        );
      }
    }

    // Collect other pending offers for this trip BEFORE accept (they'll be revoked by RPC)
    let revokedOffers: { id: string; driver_id: string }[] = [];
    if (offerRow?.trip_id) {
      const { data: pendingOffers } = await supabase
        .from("ride_offers")
        .select("id, driver_id")
        .eq("trip_id", offerRow.trip_id)
        .neq("id", offer_id)
        .neq("driver_id", driver_id)
        .eq("status", "pending");
      revokedOffers = (pendingOffers || []).filter(
        (o): o is { id: string; driver_id: string } => !!(o?.id && o?.driver_id),
      );
    }

    // Hard SSOT: never hijack active trip via regular accept
    if (
      activeTripId &&
      offerRow?.trip_id &&
      activeTripId !== offerRow.trip_id
    ) {
      return businessFailureResponse(
        "ACTIVE_TRIP_REQUIRES_STACKED_ACCEPT",
        "Finish or complete your current trip first — accept the next ride as a stacked offer",
        { active_trip_id: activeTripId, offer_trip_id: offerRow.trip_id },
      );
    }

    const ns = String(offerRow?.negotiation_status ?? "").toLowerCase();
    const customerCounterFare = Number(offerRow?.customer_counter_fare ?? 0);
    const allowCustomerCounter =
      customerCounterFare > 0
      && ["waiting_driver_final", "waiting_driver", "driver_accepted_counter"].includes(ns);

    console.log("[accept-offer] ACCEPT_ORIGINAL_RPC_REQUEST", {
      offer_id,
      driver_id,
      negotiation_status: ns,
      allow_customer_counter: allowCustomerCounter,
    });

    const { data, error } = await supabase.rpc("accept_ride_offer", {
      p_offer_id: offer_id,
      p_driver_id: driver_id,
      p_allow_customer_counter: allowCustomerCounter,
    });

    if (error) {
      console.error("[accept-offer] ACCEPT_ORIGINAL_RPC_ERROR", { offer_id, message: error.message });
      return businessFailureResponse("DATABASE_ERROR", error.message, { offer_id });
    }

    console.log("[accept-offer] ACCEPT_ORIGINAL_RPC_RESULT", data);

    if (!data.success) {
      console.error("[accept-offer] ACCEPT_ORIGINAL_RPC_ERROR", {
        offer_id,
        error: data.error,
        message: data.message,
      });
      return businessFailureResponse(
        data.error ?? "ACCEPT_FAILED",
        data.message || "Failed to accept offer",
        { offer_id, ...data },
      );
    }

    console.log("[accept-offer] ACCEPT_ORIGINAL_RPC_SUCCESS", {
      offer_id,
      trip_id: data.trip_id,
      fare_source: data.fare_source,
      accepted_via: data.accepted_via,
    });

    const acceptedTripId = data.trip_id ?? offerRow?.trip_id;

    // ── Send RIDE_STOP pushes to clear native notifications ──
    // To the accepting driver (dismiss their heads-up / full-screen notification)
    sendRideStopPush(supabaseUrl, supabaseKey, driver_id, "accepted", {
      offer_id,
      trip_id: acceptedTripId,
    }).catch(e =>
      console.error("[accept-offer] RIDE_STOP push error (self):", e)
    );
    for (const row of revokedOffers) {
      sendRideStopPush(supabaseUrl, supabaseKey, row.driver_id, "accepted_other", {
        offer_id: row.id,
        trip_id: acceptedTripId,
      }).catch(e =>
        console.error("[accept-offer] RIDE_STOP push error (revoked):", e)
      );
    }

    // If this was a scheduled urgent offer, update scheduled_status
    const tripId = data.trip_id;
    if (tripId && offerRow?.is_urgent_dispatch) {
      console.log("[accept-offer] Scheduled urgent offer accepted — updating scheduled_status");
      await supabase
        .from("trips")
        .update({
          scheduled_status: "driver_en_route",
          confirm_deadline_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", tripId);
    }

    // Fetch full trip data to return to client (eliminates post-accept fetch)
    let tripData = null;
    if (tripId) {
      const { data: driver } = await supabase
        .from("drivers")
        .select("first_name, last_name, phone, display_rating, rating")
        .eq("id", driver_id)
        .single();

      const { data: trip } = await supabase
        .from("trips")
        .select("*")
        .eq("id", tripId)
        .single();

      tripData = trip;

      console.log("[accept-offer] Driver assigned:", {
        tripId,
        driver: driver?.first_name,
        passengerId: trip?.passenger_id,
      });
    }

    if (tripId) {
      const { error: acceptedLogErr } = await supabase.rpc("record_booking_delivery", {
        p_booking_id: tripId,
        p_phase: "accepted",
        p_driver_id: driver_id,
        p_offer_id: offer_id,
        p_source: "edge_accept_offer",
        p_detail: {
          accepted_via: "rpc_accept_ride_offer",
          is_stacked: false,
        },
      });
      if (acceptedLogErr) {
        console.warn("[accept-offer] record_booking_delivery(accepted) failed:", acceptedLogErr);
      }
    }

    const duration_ms = elapsed();
    logRequestDuration("accept-offer", duration_ms, {
      request_id: requestId,
      path: "accept_ride_offer",
      offer_id,
      trip_id: tripId ?? null,
      is_stacked: false,
    });
    finishEdgeRequestLog("accept-offer", duration_ms, {
      request_id: requestId,
      trip_id: tripId ?? null,
      offer_id,
      path: "accept_ride_offer",
    });
    return successResponse(withDuration({ ...data, trip: tripData }, duration_ms, {
      source: "accept-offer",
      requestId,
    }));

  } catch (error) {
    console.error("[accept-offer] Error:", error);
    return errorResponse("INTERNAL_ERROR", String(error), 500);
  }
});
