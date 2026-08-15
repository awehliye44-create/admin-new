/**
 * driver-fare-final – Driver's final accept/decline after customer responds
 * 
 * CONTRACT SECTION 9:
 * - ACCEPT → CONFIRMED(finalFare=customerOfferFare)
 * - DECLINE or TIMEOUT → exclude driver + rebroadcast same trip (no new trip id);
 *   negotiation_disabled=true — future drivers see normal accept/decline at original fare only.
 * 
 * Also handles declined_customer_awaiting_driver (Driver second chance at £X):
 * - ACCEPT / ACCEPT_STANDARD → CONFIRMED(finalFare=original fare) via accept_ride_offer
 * - DECLINE / timeout → exclude driver + rebroadcast same trip (no new trip id)
 * 
 * POST body: { offer_id, driver_id, action: "ACCEPT"|"ACCEPT_STANDARD"|"DECLINE" }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  handleCORSPreflight,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  isValidUUID,
  isValidAction,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import { assignedNegotiationSuccessBody } from "../_shared/assignedNegotiationSnapshot.ts";
import { finalizeRideAssignmentSideEffects } from "../_shared/rideAssignmentFinalize.ts";
import { finalizeNegotiationFailureAndRebroadcast } from "../_shared/negotiationFailureRematch.ts";
import { resolveNegotiationBaseFarePence } from "../_shared/negotiationBaseFare.ts";
import { presetNegotiationSourceIneligibility } from "../_shared/presetNegotiationEligibility.ts";
import {
  DRIVER_ACCEPTED_COUNTER_BODY,
  DRIVER_ACCEPTED_COUNTER_TITLE,
  FINDING_ANOTHER_DRIVER_UPDATED_FARE_BODY,
} from "../_shared/negotiationPushCopy.ts";
import {
  ensureNegotiationPayableAuthorised,
  isPaymentGateAcceptFailure,
  NEGOTIATION_PAYABLE_INSUFFICIENT_CODE,
  NEGOTIATION_PAYABLE_INSUFFICIENT_MESSAGE,
} from "../_shared/negotiationPayableAuthorisation.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://thazislrdkjpvvghtvzo.supabase.co";
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  const ip = getClientIP(req);
  const rl = checkRateLimit(ip, { limit: 30, windowMs: 60000, keyPrefix: "driver-fare-final" });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return errorResponse("UNAUTHORIZED", "Missing authorization", 401);

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await userClient.auth.getUser(token);
    if (authError || !user) return errorResponse("UNAUTHORIZED", "Invalid token", 401);

    const body = await req.json();
    const {
      offer_id: raw_offer_id,
      driver_id,
      action,
      ride_id: raw_ride_id,
    } = body;

    if (!isValidUUID(driver_id)) return errorResponse("VALIDATION_ERROR", "Invalid driver_id", 400);
    if (!isValidAction(action, ["ACCEPT", "ACCEPT_STANDARD", "DECLINE"])) {
      return errorResponse("VALIDATION_ERROR", "Action must be ACCEPT, ACCEPT_STANDARD, or DECLINE", 400);
    }

    // Verify driver
    const { data: driver } = await supabase
      .from("drivers")
      .select("id, user_id")
      .eq("id", driver_id)
      .single();

    if (!driver || driver.user_id !== user.id) {
      return errorResponse("FORBIDDEN", "Not your driver profile", 403);
    }

    const resolveOfferIdFromRideId = async (): Promise<string | null> => {
      if (!isValidUUID(raw_ride_id)) return null;
      const { data: fallbackOffer, error: fallbackErr } = await supabase
        .from("ride_offers")
        .select("id")
        .eq("trip_id", raw_ride_id)
        .eq("driver_id", driver_id)
        .in("negotiation_status", ["waiting_driver_final", "declined_customer_awaiting_driver"])
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (fallbackErr) {
        console.warn("[driver-fare-final] offer fallback by ride_id failed", {
          ride_id: raw_ride_id,
          driver_id,
          error: fallbackErr.message,
        });
        return null;
      }
      if (fallbackOffer?.id) {
        console.log("[driver-fare-final] resolved offer_id from ride_id", {
          raw_offer_id,
          ride_id: raw_ride_id,
          offer_id: fallbackOffer.id,
        });
        return fallbackOffer.id;
      }
      return null;
    };

    let offer_id: string | null = isValidUUID(raw_offer_id) ? raw_offer_id : null;
    if (!offer_id) {
      offer_id = await resolveOfferIdFromRideId();
    }

    if (!offer_id) {
      return errorResponse("VALIDATION_ERROR", "Invalid offer_id", 400);
    }

    const fetchOfferWithTrip = (id: string) =>
      supabase
        .from("ride_offers")
        .select("*, trips(id, status, excluded_driver_ids, base_fare_pence, estimated_fare, fare, fare_breakdown, gross_fare_pence, estimated_total_pence, fare_snapshot_json, passenger_id, is_scheduled, dispatch_mode, trip_type, corporate_account_id, booking_source)")
        .eq("id", id)
        .eq("driver_id", driver_id)
        .maybeSingle();

    // Get offer with trip; if the provided offer_id is stale (no row for this
    // driver), retry once via ride_id so a stale client id cannot freeze accepts.
    let { data: offer, error: offerErr } = await fetchOfferWithTrip(offer_id);
    if ((offerErr || !offer) && isValidUUID(raw_ride_id) && raw_ride_id !== offer_id) {
      const recoveredId = await resolveOfferIdFromRideId();
      if (recoveredId && recoveredId !== offer_id) {
        console.warn("[driver-fare-final] stale offer_id recovered via ride_id", {
          stale_offer_id: offer_id,
          recovered_offer_id: recoveredId,
        });
        offer_id = recoveredId;
        ({ data: offer, error: offerErr } = await fetchOfferWithTrip(offer_id));
      }
    }

    if (offerErr || !offer) return errorResponse("NOT_FOUND", "Offer not found", 404);

    const validNegotiationStatuses = ["waiting_driver_final", "declined_customer_awaiting_driver"];
    if (!validNegotiationStatuses.includes(offer.negotiation_status)) {
      return errorResponse(
        "INVALID_STATE",
        `Offer negotiation is ${offer.negotiation_status}, expected one of: ${validNegotiationStatuses.join(", ")}`,
        409
      );
    }

    const trip = offer.trips;
    if (!trip) return errorResponse("NOT_FOUND", "Trip not found", 404);

    const sourceBlock = presetNegotiationSourceIneligibility(trip as {
      is_scheduled?: boolean | null;
      dispatch_mode?: string | null;
      trip_type?: string | null;
      corporate_account_id?: string | null;
      booking_source?: string | null;
    });
    if (sourceBlock) {
      return errorResponse("DISABLED", sourceBlock.message, 403, { reason: sourceBlock.reason });
    }

    if (
      action === "ACCEPT"
      && (offer.status === "accepted" || offer.negotiation_status === "confirmed")
    ) {
      const { data: tripRow } = await supabase
        .from("trips")
        .select("id, driver_id, final_fare_pence, fare_snapshot_json")
        .eq("id", trip.id)
        .maybeSingle();
      if (tripRow?.driver_id === driver_id) {
        return successResponse({
          success: true,
          action: "ACCEPTED",
          idempotent: true,
          trip_id: trip.id,
          offer_id,
          final_fare_pence: tripRow.final_fare_pence ?? offer.customer_counter_fare,
          fare_source: (tripRow.fare_snapshot_json as { fare_source?: string } | null)?.fare_source
            ?? "customer_counter_offer",
        });
      }
    }

    if (action === "DECLINE") {
      if (offer.status === "accepted" || offer.negotiation_status === "confirmed") {
        return successResponse({
          success: true,
          action: "ALREADY_ACCEPTED",
          trip_id: trip.id,
          message: "Offer already accepted — decline ignored",
        });
      }
      const { data: assignedTrip } = await supabase
        .from("trips")
        .select("id, driver_id, status")
        .eq("id", trip.id)
        .maybeSingle();
      if (
        assignedTrip?.driver_id === driver_id
        && ["accepted", "confirmed", "driver_assigned", "arrived_pickup", "arrived", "in_progress"]
          .includes(assignedTrip.status ?? "")
      ) {
        return successResponse({
          success: true,
          action: "ALREADY_ACCEPTED",
          trip_id: trip.id,
          message: "Trip already assigned — decline ignored",
        });
      }
    }

    const rematchSameTrip = async (
      offerTerminalStatus: "expired" | "declined" | "revoked",
      offerNegotiationStatus: string,
    ) => {
      return finalizeNegotiationFailureAndRebroadcast(supabase, {
        tripId: trip.id,
        failedDriverId: driver_id,
        offerId: offer_id,
        offerTerminalStatus,
        offerNegotiationStatus,
      });
    };

    const assignAcceptedNegotiation = async (args: {
      finalFarePence: number;
      fareSource: string;
      auditEvent: string;
    }) => {
      const cover = await ensureNegotiationPayableAuthorised({
        supabase,
        tripId: trip.id,
        requiredFarePence: args.finalFarePence,
        owner: `negotiation_accept:${args.fareSource}:${trip.id}:${offer_id}`,
      });
      if (!cover.ok) {
        return errorResponse(cover.code, cover.message, cover.status);
      }

      const { data: acceptResult, error: acceptErr } = await supabase.rpc("accept_ride_offer", {
        p_offer_id: offer_id,
        p_driver_id: driver_id,
      });
      if (acceptErr || acceptResult?.success !== true) {
        const acceptMessage =
          acceptErr?.message ?? acceptResult?.message ?? acceptResult?.error ?? "Failed to assign trip";
        if (isPaymentGateAcceptFailure(String(acceptMessage))) {
          return errorResponse(
            NEGOTIATION_PAYABLE_INSUFFICIENT_CODE,
            NEGOTIATION_PAYABLE_INSUFFICIENT_MESSAGE,
            409,
          );
        }
        return errorResponse("ACCEPT_FAILED", acceptMessage, 409);
      }

      const resolvedFarePence =
        (acceptResult?.final_fare_pence as number | undefined) ?? args.finalFarePence;
      const finalize = await finalizeRideAssignmentSideEffects(supabase, {
        tripId: trip.id,
        offerId: offer_id,
        driverId: driver_id,
        source: "edge_driver_fare_final",
        fareSource: (acceptResult?.fare_source as string) ?? args.fareSource,
        acceptedVia: "accept_ride_offer",
      });

      await supabase.rpc("log_audit_event", {
        p_event_type: args.auditEvent,
        p_driver_id: driver_id,
        p_trip_id: trip.id,
        p_details: {
          offer_id,
          final_fare_pence: resolvedFarePence,
          fare_source: args.fareSource,
        },
      });

      return successResponse(assignedNegotiationSuccessBody({
        tripId: trip.id,
        offerId: offer_id,
        driverId: driver_id,
        snapshot: finalize.snapshot ?? null,
        fallbackFarePence: resolvedFarePence,
        fallbackFareSource: (acceptResult?.fare_source as string) ?? args.fareSource,
      }));
    };

    // Driver second chance at original £X after Customer did not accept £Y.
    if (
      (action === "ACCEPT" || action === "ACCEPT_STANDARD")
      && offer.negotiation_status === "declined_customer_awaiting_driver"
    ) {
      const graceMs = offer.grace_window_expires_at
        ? new Date(offer.grace_window_expires_at).getTime()
        : offer.negotiation_expires_at
          ? new Date(offer.negotiation_expires_at).getTime()
          : null;
      if (graceMs != null && graceMs + 2000 < Date.now()) {
        await rematchSameTrip("expired", "timeout_driver");
        return errorResponse("TIMEOUT", "Response time expired", 410);
      }
      const originalFarePence = resolveNegotiationBaseFarePence(trip);
      if (originalFarePence <= 0) {
        return errorResponse("INVALID_STATE", "Original fare missing", 409);
      }
      return await assignAcceptedNegotiation({
        finalFarePence: originalFarePence,
        fareSource: "original_fare",
        auditEvent: "driver_accepted_original_after_customer_decline",
      });
    }

    if (action === "ACCEPT_STANDARD") {
      return errorResponse(
        "INVALID_STATE",
        "Accept original fare is only valid during the Driver second-chance window",
        409,
      );
    }

    // ── ACCEPT: driver accepts customer's COUNTER offer → CONFIRMED ────────
    if (action === "ACCEPT") {
      if (offer.negotiation_status !== "waiting_driver_final") {
        return errorResponse("INVALID_STATE", "ACCEPT only valid when waiting for driver final on counter", 409);
      }

      // Check timeout (2s grace for in-flight accept taps near deadline)
      const respondByMs = offer.driver_respond_by
        ? new Date(offer.driver_respond_by).getTime()
        : null;
      if (respondByMs != null && respondByMs + 2000 < Date.now()) {
        await supabase.from("ride_offers")
          .update({ negotiation_status: "timeout_driver", status: "expired", updated_at: new Date().toISOString() })
          .eq("id", offer_id);

        // SECTION 9: timeout on customer counter = LOCK permanently
        await rematchSameTrip("expired", "timeout_driver");

        return errorResponse("TIMEOUT", "Response time expired", 410);
      }

      const finalFarePence = offer.customer_counter_fare;
      if (typeof finalFarePence !== "number" || finalFarePence <= 0) {
        return errorResponse("INVALID_STATE", "Customer counter fare missing", 409);
      }
      console.log("[driver-fare-final] DRIVER_ACCEPTED_COUNTER", {
        offer_id,
        trip_id: trip.id,
        driver_id,
        amount_pence: finalFarePence,
        customer_counter_fare: offer.customer_counter_fare,
        driver_offer_fare: offer.driver_offer_fare,
      });

      console.log("[driver-fare-final] ACCEPT_COUNTER_PAYLOAD", {
        ride_id: trip.id,
        ride_offer_id: offer_id,
        negotiation_id: offer_id,
        driver_id,
        customer_counter_fare: offer.customer_counter_fare,
        negotiation_status: offer.negotiation_status,
        offer_status: offer.status,
      });

      const cover = await ensureNegotiationPayableAuthorised({
        supabase,
        tripId: trip.id,
        requiredFarePence: finalFarePence,
        owner: `negotiation_accept_z:${trip.id}:${offer_id}`,
      });
      if (!cover.ok) {
        return errorResponse(cover.code, cover.message, cover.status);
      }

      const { data: acceptResult, error: acceptErr } = await supabase.rpc("accept_ride_offer", {
        p_offer_id: offer_id,
        p_driver_id: driver_id,
      });
      if (acceptErr || acceptResult?.success !== true) {
        console.error("[driver-fare-final] ACCEPT_COUNTER_RPC_ERROR", {
          error: acceptErr?.message ?? acceptResult?.error,
          message: acceptResult?.message,
          negotiation_status: offer.negotiation_status,
          result: acceptResult,
        });
        const acceptMessage =
          acceptErr?.message ?? acceptResult?.message ?? acceptResult?.error ?? "Failed to assign trip";
        if (isPaymentGateAcceptFailure(String(acceptMessage))) {
          return errorResponse(
            NEGOTIATION_PAYABLE_INSUFFICIENT_CODE,
            NEGOTIATION_PAYABLE_INSUFFICIENT_MESSAGE,
            409,
          );
        }
        return errorResponse("ACCEPT_FAILED", acceptMessage, 409);
      }

      console.log("[driver-fare-final] ACCEPT_COUNTER_RPC_SUCCESS", {
        trip_id: acceptResult.trip_id,
        final_fare_pence: acceptResult.final_fare_pence,
        fare_source: acceptResult.fare_source,
        counter_offer_amount_pence: acceptResult.counter_offer_amount_pence,
      });

      const resolvedFarePence =
        (acceptResult?.final_fare_pence as number | undefined) ?? finalFarePence;
      console.log("[driver-fare-final] FINAL_FARE_SET", {
        trip_id: trip.id,
        final_fare_pence: resolvedFarePence,
        fare_source: acceptResult?.fare_source ?? "customer_counter_offer",
      });

      const finalize = await finalizeRideAssignmentSideEffects(supabase, {
        tripId: trip.id,
        offerId: offer_id,
        driverId: driver_id,
        source: "edge_driver_fare_final",
        fareSource: (acceptResult?.fare_source as string) ?? "customer_counter_offer",
        acceptedVia: "accept_ride_offer",
      });
      const tripAfter = finalize.snapshot;
      console.log("[driver-fare-final] BOOKING_CREATED_WITH_FINAL_FARE", {
        trip_id: trip.id,
        final_fare_pence: tripAfter?.final_fare_pence,
        fare: tripAfter?.fare,
        fare_source: tripAfter?.fare_source,
      });
      console.log("[driver-fare-final] NEGOTIATION_RESOLVED_DRIVER", {
        trip_id: trip.id,
        offer_id,
        driver_id,
        final_fare_pence: tripAfter?.final_fare_pence ?? resolvedFarePence,
        commission_pence: tripAfter?.commission_pence,
        driver_net_pence: tripAfter?.driver_net_pence,
        tier_commission_percent: tripAfter?.driver_tier_commission_percent,
      });
      if (tripAfter?.commission_pence != null) {
        console.log("[driver-fare-final] COMMISSION_RECALCULATED", {
          trip_id: trip.id,
          commission_pence: tripAfter.commission_pence,
          driver_net_pence: tripAfter.driver_net_pence,
        });
        console.log("[driver-fare-final] TIER_COMMISSION_USED", {
          trip_id: trip.id,
          tier_commission_percent: tripAfter.driver_tier_commission_percent,
        });
        console.log("[driver-fare-final] DRIVER_NET_UPDATED", {
          trip_id: trip.id,
          driver_net_pence: tripAfter.driver_net_pence,
        });
      }

      await supabase.rpc("log_audit_event", {
        p_event_type: "driver_accepted_counter",
        p_driver_id: driver_id,
        p_trip_id: trip.id,
        p_details: {
          offer_id,
          final_fare_pence: resolvedFarePence,
          fare_source: "customer_counter_offer",
          event: "DRIVER_ACCEPTED_COUNTER",
        },
      });

      const passengerId = (trip as { passenger_id?: string | null }).passenger_id;
      if (passengerId) {
        try {
          await fetch(`${supabaseUrl}/functions/v1/send-trip-notification`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({
              userId: passengerId,
              tripId: trip.id,
              event: "driver_accepted_counter",
              title: DRIVER_ACCEPTED_COUNTER_TITLE,
              body: DRIVER_ACCEPTED_COUNTER_BODY,
            }),
          });
        } catch (pushErr) {
          console.warn("[driver-fare-final] customer accept push failed:", pushErr);
        }
      }

      return successResponse(assignedNegotiationSuccessBody({
        tripId: trip.id,
        offerId: offer_id,
        driverId: driver_id,
        snapshot: finalize.snapshot ?? null,
        fallbackFarePence: resolvedFarePence,
        fallbackFareSource: (acceptResult?.fare_source as string) ?? "customer_counter_offer",
      }));
    }

    // ── DECLINE: driver declines → SECTION 9 lock rule ────────────────────
    if (action === "DECLINE") {
      const rematch = await rematchSameTrip("declined", "declined_driver");

      await supabase.rpc("log_audit_event", {
        p_event_type: offer.negotiation_status === "declined_customer_awaiting_driver"
          ? "driver_declined_after_customer_decline"
          : "driver_declined_counter",
        p_driver_id: driver_id,
        p_trip_id: trip.id,
        p_details: {
          offer_id,
          negotiation_status: offer.negotiation_status,
          trip_id: trip.id,
          rematch_success: rematch.success,
        },
      });

      const passengerId = (trip as { passenger_id?: string | null }).passenger_id;
      if (passengerId && offer.negotiation_status !== "declined_customer_awaiting_driver") {
        try {
          await fetch(`${supabaseUrl}/functions/v1/send-trip-notification`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({
              userId: passengerId,
              tripId: trip.id,
              event: "finding_another_driver_updated_fare",
              title: "Finding another driver",
              body: FINDING_ANOTHER_DRIVER_UPDATED_FARE_BODY,
            }),
          });
        } catch (pushErr) {
          console.warn("[driver-fare-final] customer reject push failed:", pushErr);
        }
      }

      return successResponse({
        success: true,
        action: "DECLINED",
        message: "Ride offered to other drivers",
        trip_id: trip.id,
        negotiation_disabled: true,
      });
    }

    return errorResponse("INVALID_ACTION", "Unknown action", 400);
  } catch (err) {
    console.error("[driver-fare-final] Error:", err);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
