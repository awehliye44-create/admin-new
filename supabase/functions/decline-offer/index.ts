import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { assertGlobalRebroadcastAllowed } from "../_shared/rebroadcastPolicy.ts";
import { recordDispatchWaveSnapshot } from "../_shared/recordDispatchWaveSnapshot.ts";
import { notifyCustomerTripLifecycle } from "../_shared/customerTripLifecycleNotify.ts";
import {
  handleCORSPreflight,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  isValidUUID,
  validationErrorResponse,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import { requireAuthenticatedUser } from "../_shared/edgeAuth.ts";

interface DeclineRequest {
  offer_id: string;
  driver_id: string;
  reason?: string;
}

// Rate limit config: 50 requests per minute per IP
const RATE_LIMIT_CONFIG = { limit: 50, windowMs: 60000, keyPrefix: 'decline-offer' };

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
      body: "Ride declined",
      data,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    console.warn(`[decline-offer] RIDE_STOP push response ${resp.status}: ${errText}`);
  }
}

/**
 * Decline Offer Edge Function
 * 
 * Allows a driver to decline a ride offer.
 * The offer is marked as declined and the driver won't see it again.
 * 
 * For scheduled urgent offers (is_urgent_dispatch=true):
 * - Clears confirmed_driver_id from the trip
 * - Converts to urgent auto-dispatch for other nearby drivers
 * 
 * Security features:
 * - JWT authentication (driver identity derived from token)
 * - Rate limiting (50 req/min per IP)
 * - Input validation (UUID format)
 * - Security headers
 */
Deno.serve(async (req) => {
  console.log("[decline-offer] Received request:", req.method);

  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  // Rate limiting
  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    console.log("[decline-offer] Rate limited:", clientIP);
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

    const body: DeclineRequest = await req.json();
    const { offer_id, reason } = body;

    // Reject if body driver_id doesn't match authenticated driver
    if (body.driver_id && body.driver_id !== authenticatedDriverId) {
      console.error("[decline-offer] driver_id mismatch: body=", body.driver_id, "auth=", authenticatedDriverId);
      return errorResponse("FORBIDDEN", "driver_id does not match authenticated user", 403);
    }

    const driver_id = authenticatedDriverId;

    console.log("[decline-offer] Processing:", { offer_id, driver_id });

    // Input validation
    const validationErrors: Record<string, string> = {};
    
    if (!offer_id) {
      validationErrors.offer_id = "offer_id is required";
    } else if (!isValidUUID(offer_id)) {
      validationErrors.offer_id = "offer_id must be a valid UUID";
    }
    
    if (Object.keys(validationErrors).length > 0) {
      return validationErrorResponse(validationErrors);
    }

    // Fetch offer details BEFORE declining (to check flags)
    const { data: offerRow, error: offerFetchErr } = await supabase
      .from("ride_offers")
      .select("trip_id, is_urgent_dispatch, status")
      .eq("id", offer_id)
      .eq("driver_id", driver_id)
      .single();

    if (offerFetchErr || !offerRow) {
      console.error("[decline-offer] Offer not found:", offerFetchErr);
      return errorResponse("OFFER_NOT_FOUND", "Offer not found", 404);
    }

    // Call the database function to mark as declined
    const { data, error } = await supabase.rpc("decline_ride_offer", {
      p_offer_id: offer_id,
      p_driver_id: driver_id,
      p_reason: reason || null,
    });

    if (error) {
      console.error("[decline-offer] RPC error:", error);
      return errorResponse("DATABASE_ERROR", error.message, 500);
    }

    console.log("[decline-offer] Result:", data);

    if (!data.success) {
      // OFFER_NOT_PENDING = idempotent success (already declined/expired, race condition)
      // Return 200 so the client treats it as a no-op instead of an error
      if (data.error === "OFFER_NOT_PENDING") {
        console.log("[decline-offer] Offer already handled, treating as idempotent success");
        return successResponse({ ...data, success: true, idempotent: true });
      }
      const statusCode = data.error === "OFFER_NOT_FOUND" ? 404 : 400;
      return errorResponse(data.error, data.message || "Failed to decline offer", statusCode);
    }

    // ── Send RIDE_STOP to declining driver to dismiss native notification ──
    sendRideStopPush(supabaseUrl, supabaseKey, driver_id, "declined", {
      offer_id,
      trip_id: offerRow.trip_id,
    }).catch(e =>
      console.error("[decline-offer] RIDE_STOP push error:", e)
    );

    const { error: declinedLogErr } = await supabase.rpc("record_booking_delivery", {
      p_booking_id: offerRow.trip_id,
      p_phase: "driver_declined",
      p_driver_id: driver_id,
      p_offer_id: offer_id,
      p_source: "edge_decline_offer",
      p_detail: {
        decline_reason: reason || null,
        urgent_dispatch: !!offerRow.is_urgent_dispatch,
      },
    });
    if (declinedLogErr) {
      console.warn("[decline-offer] record_booking_delivery(driver_declined) failed:", declinedLogErr);
    }

    // ── Standard decline: rebroadcast to other eligible drivers (same trip_id) ──
    const tripIdForRebroadcast = offerRow.trip_id as string;

    // ── SCAN & GO: Driver-locked booking — cancel immediately, NEVER reassign ──
    // Detect via offer_type (set by scan-and-go function) OR trip's dispatch_mode (canonical lock marker).
    const { data: tripRow } = await supabase
      .from("trips")
      .select("job_type, dispatch_mode, passenger_id")
      .eq("id", offerRow.trip_id)
      .single();

    const isScanAndGo =
      tripRow?.dispatch_mode === "scan_and_go" ||
      tripRow?.job_type === "scan_and_go";

    if (isScanAndGo) {
      const tripId = offerRow.trip_id;
      console.log("[decline-offer] Scan & Go offer declined — cancelling booking (no reassignment):", tripId);

      // Cancel the trip — no reassignment, no broadcast, no fallback.
      // Clear all driver pointers so dispatch_mode='scan_and_go' + locked status
      // can never be picked up by auto-dispatch (auto-dispatch already skips
      // locked scan_and_go, but we also clear the lock for hygiene).
      await supabase
        .from("trips")
        .update({
          status: "cancelled",
          dispatch_status: "cancelled",
          cancelled_at: new Date().toISOString(),
          cancelled_by: "driver",
          cancellation_reason: "driver_declined_scan_and_go",
          driver_id: null,
          confirmed_driver_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", tripId);

      // Defensive: ensure the declining driver is not left holding this trip
      // as their current_trip_id (shouldn't be set on decline, but in case a
      // rare trigger flipped it earlier in the lifecycle).
      await supabase
        .from("drivers")
        .update({ current_trip_id: null, updated_at: new Date().toISOString() })
        .eq("id", driver_id)
        .eq("current_trip_id", tripId);

      // Clear customer's active trip pointer so they can scan again
      if (tripRow?.passenger_id) {
        await supabase
          .from("customers")
          .update({ active_trip_id: null })
          .eq("id", tripRow.passenger_id)
          .eq("active_trip_id", tripId);
      }

      // Terminal Scan & Go cancel — same Customer lifecycle WAV path (not a parallel producer).
      if (tripRow?.passenger_id) {
        void notifyCustomerTripLifecycle(supabase, {
          passengerId: tripRow.passenger_id,
          tripId,
          event: "trip_cancelled",
          title: "ONECAB TRIP CANCELLED",
          body: "Your Scan & Go booking has been cancelled.",
        }).catch((e) =>
          console.warn("[decline-offer] customer trip_cancelled push failed:", e)
        );
      }

      return successResponse({ ...data, scan_and_go_cancelled: true });
    }

    if (!isScanAndGo && !offerRow.is_urgent_dispatch) {
      const mayRebroadcast = await assertGlobalRebroadcastAllowed(
        supabase,
        tripIdForRebroadcast,
        "decline-offer:standard_decline",
      );
      if (!mayRebroadcast) {
        return successResponse({ ...data, rebroadcast_skipped: true });
      }

      // Single dispatch orchestrator: auto-dispatch edge function only.
      // REMOVED: dispatch_trip_offers SQL RPC (created un-audited, presetless offers).
      // auto-dispatch handles wave expansion, eligibility logging, preset attachment,
      // wave snapshot audit, and push delivery tracking.
      try {
        const { data: tripRoundRow } = await supabase
          .from("trips")
          .select("current_broadcast_round")
          .eq("id", tripIdForRebroadcast)
          .maybeSingle();
        const nextRound = (tripRoundRow?.current_broadcast_round ?? 0) + 1;
        await recordDispatchWaveSnapshot(supabase, {
          tripId: tripIdForRebroadcast,
          dispatchRound: nextRound,
          stage: "considered",
          driverId: null,
          source: "decline_offer",
          metadata: {
            wave_context: "decline_rebroadcast_trigger",
            trigger_reason: "driver_declined",
            declined_driver_id: driver_id,
          },
        });

        const resp = await fetch(`${supabaseUrl}/functions/v1/auto-dispatch`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({
            trip_id: tripIdForRebroadcast,
            force_rebroadcast: true,
            trigger_reason: "driver_declined",
            declined_driver_id: driver_id,
          }),
        });
        const dispatchBody = await resp.json().catch(() => ({}));
        console.log("[decline-offer] auto-dispatch wave after decline:", resp.status, dispatchBody);
      } catch (dispatchErr) {
        console.warn("[decline-offer] auto-dispatch after decline failed:", dispatchErr);
      }
    }

    // ── SCHEDULED URGENT ESCALATION ──
    if (offerRow.is_urgent_dispatch) {
      const tripId = offerRow.trip_id;
      console.log("[decline-offer] Urgent scheduled offer declined — escalating trip:", tripId);

      const { error: tripUpdateErr } = await supabase
        .from("trips")
        .update({
          scheduled_status: "broadcasting",
          status: "searching",
          driver_id: null,
          confirmed_driver_id: null,
          confirm_deadline_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", tripId);

      if (tripUpdateErr) {
        console.error("[decline-offer] Failed to escalate trip:", tripUpdateErr);
      } else {
        try {
          const resp = await fetch(`${supabaseUrl}/functions/v1/auto-dispatch`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${supabaseKey}`,
            },
            body: JSON.stringify({ trip_id: tripId, force_rebroadcast: true }),
          });
          const dispatchResult = await resp.json().catch(() => ({}));
          console.log("[decline-offer] Auto-dispatch triggered:", dispatchResult);
        } catch (dispatchErr) {
          console.error("[decline-offer] Auto-dispatch trigger failed:", dispatchErr);
        }
      }
    }

    return successResponse(data);

  } catch (error) {
    console.error("[decline-offer] Error:", error);
    return errorResponse("INTERNAL_ERROR", String(error), 500);
  }
});
