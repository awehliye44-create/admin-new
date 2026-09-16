/**
 * customer-fare-decision – Customer responds to driver's fare offer
 * 
 * Actions: ACCEPT, DECLINE, COUNTER (counter must match remaining admin preset options)
 * 
 * DECLINE / ignore / Customer £Y timeout: one Driver second chance at original £X
 * (declined_customer_awaiting_driver). Do not rematch or exclude yet.
 * COUNTER £Z: persist as new original fare immediately; Driver has the
 * Admin service-area countdown to Accept £Z. No second chance after £Z.
 * 
 * POST body: { offer_id, action: "ACCEPT"|"DECLINE"|"COUNTER", selected_fare_pence?: number }
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
import { broadcastCustomerCounterOffer } from "../_shared/driverNegotiationBroadcast.ts";
import { buildDriverNegotiationPushData } from "../_shared/driverNegotiationPush.ts";
import {
  OFFER_ACCEPTED_ASSIGNED_BODY,
  OFFER_ACCEPTED_ASSIGNED_TITLE,
  customerCounterOfferPushBody,
} from "../_shared/negotiationPushCopy.ts";
import { enrichOfferSnapshotDriverNet } from "../_shared/driverOfferNetPreview.ts";
import { assignedNegotiationSuccessBody } from "../_shared/assignedNegotiationSnapshot.ts";
import { finalizeRideAssignmentSideEffects } from "../_shared/rideAssignmentFinalize.ts";
import { resolveNegotiationBaseFarePence } from "../_shared/negotiationBaseFare.ts";
import { presetNegotiationSourceIneligibility } from "../_shared/presetNegotiationEligibility.ts";
import {
  loadServiceAreaNegotiationCountdown,
  resolveNegotiationDeadlineIso,
} from "../_shared/negotiation-deadline.ts";
import {
  ensureNegotiationPayableAuthorised,
  isPaymentGateAcceptFailure,
  NEGOTIATION_PAYABLE_INSUFFICIENT_CODE,
  NEGOTIATION_PAYABLE_INSUFFICIENT_MESSAGE,
} from "../_shared/negotiationPayableAuthorisation.ts";
import { claimCustomerNegotiationDecision } from "../_shared/customerNegotiationDecisionHold.ts";
import { enterDriverSecondChanceAtOriginalFare } from "../_shared/customerNegotiationGrace.ts";
import {
  extractPresetOptionsFromOffer,
  faresMatchPence,
  type PresetOptionCanonical,
} from "../_shared/presetOptionsCanonical.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://thazislrdkjpvvghtvzo.supabase.co";
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function postDriverNegotiationPush(
  body: Record<string, unknown>,
  label: string,
): Promise<void> {
  const res = await fetch(`${supabaseUrl}/functions/v1/send-driver-notification`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${supabaseServiceKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`[customer-fare-decision] ${label} driver push`, {
    http_status: res.status,
    body: text.slice(0, 240),
  });
}

function extractCounterFareOptions(offer: {
  offer_snapshot?: unknown;
  driver_offer_fare?: number | null;
}): number[] {
  return extractCounterPresetOptions(offer).map((o) => o.grossFarePence);
}

function extractCounterPresetOptions(offer: {
  offer_snapshot?: unknown;
  driver_offer_fare?: number | null;
}): PresetOptionCanonical[] {
  const presetOptions = extractPresetOptionsFromOffer(offer);
  if (presetOptions.length === 0) return [];

  const driverPence = offer.driver_offer_fare ?? 0;
  const remaining = presetOptions
    .filter((o) => !faresMatchPence(o.grossFarePence, driverPence));

  const seen = new Set<number>();
  return remaining.filter((option) => {
    if (seen.has(option.grossFarePence)) return false;
    seen.add(option.grossFarePence);
    return true;
  });
}

function mapCustomerCounterRideOfferError(
  err: { message?: string } | null,
  data: unknown,
): { code: string; message: string; status: number } {
  const blob = `${err?.message ?? ""} ${typeof data === "string" ? data : JSON.stringify(data ?? {})}`
    .toLowerCase();
  if (blob.includes("fare_commit_failed")) {
    return { code: "FARE_COMMIT_FAILED", message: "Could not persist counter-offer", status: 500 };
  }
  if (blob.includes("not_waiting_customer")) {
    return {
      code: "INVALID_STATE",
      message: "Offer is not awaiting customer counter",
      status: 409,
    };
  }
  if (blob.includes("locked_driver_mismatch")) {
    return { code: "LOCKED_DRIVER_MISMATCH", message: "This offer is no longer the locked driver offer", status: 409 };
  }
  if (blob.includes("invalid_counter_fare") || blob.includes("invalid_fare")) {
    return { code: "INVALID_FARE", message: "Selected fare is not a valid counter option", status: 400 };
  }
  if (blob.includes("invalid_counter")) {
    return {
      code: "INVALID_COUNTER",
      message: "Counter-offer cannot equal the driver's offer. Use ACCEPT instead.",
      status: 400,
    };
  }
  if (
    blob.includes("ineligible_")
    || blob.includes("negotiation_disabled")
  ) {
    return { code: "DISABLED", message: "Negotiation is not available for this trip", status: 403 };
  }
  if (blob.includes("forbidden_customer") || blob.includes("customer_required")) {
    return { code: "FORBIDDEN", message: "Not your trip", status: 403 };
  }
  if (blob.includes("offer_not_found") || blob.includes("trip_not_found")) {
    return { code: "NOT_FOUND", message: "Offer not found", status: 404 };
  }
  return { code: "UPDATE_FAILED", message: "Failed to record counter-offer", status: 500 };
}

function isAwaitingCustomerDecision(offer: {
  negotiation_status?: string | null;
  status?: string | null;
  driver_offer_fare?: number | null;
}): boolean {
  if (offer.negotiation_status === "waiting_customer") return true;
  const fare = offer.driver_offer_fare;
  if (typeof fare !== "number" || fare <= 0) return false;
  return offer.status === "pending" || offer.status === "countered";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  const ip = getClientIP(req);
  const rl = checkRateLimit(ip, { limit: 30, windowMs: 60000, keyPrefix: "customer-fare-decision" });
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
    const offer_id = body.offer_id ?? body.ride_offer_id ?? body.negotiation_id;
    const action = body.action;
    const selected_fare_pence =
      typeof body.selected_fare_pence === "number"
        ? body.selected_fare_pence
        : typeof body.counter_offer_fare === "number"
          ? body.counter_offer_fare
          : Number.NaN;
    const selected_preset_key =
      typeof body.selected_preset_key === "string" && body.selected_preset_key.trim().length > 0
        ? body.selected_preset_key.trim()
        : null;
    const requestedTripId = body.ride_id ?? body.trip_id ?? null;
    const requestedDriverId = body.locked_driver_id ?? body.driver_id ?? null;
    const requestedCustomerId = body.customer_id ?? null;

    if (!isValidUUID(offer_id)) return errorResponse("VALIDATION_ERROR", "Invalid offer_id", 400);
    if (!isValidAction(action, ["ACCEPT", "DECLINE", "COUNTER"])) {
      return errorResponse("VALIDATION_ERROR", "Action must be ACCEPT, DECLINE, or COUNTER", 400);
    }

    // Get offer
    const { data: offer, error: offerErr } = await supabase
      .from("ride_offers")
      .select("*, trips(id, passenger_id, status, excluded_driver_ids, service_area_id, base_fare_pence, estimated_fare, fare, fare_breakdown, negotiation_disabled, negotiation_allowed, negotiation_owner_driver_id, current_offer_driver_id, is_scheduled, dispatch_mode, trip_type, corporate_account_id, booking_source)")
      .eq("id", offer_id)
      .single();

    if (offerErr || !offer) return errorResponse("NOT_FOUND", "Offer not found", 404);

    // Verify this is the customer's trip
    const trip = offer.trips;
    if (!trip) return errorResponse("NOT_FOUND", "Trip not found", 404);

    const { data: customerRow } = await supabase
      .from("customers")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();

    const customerRecordId = customerRow?.id ?? null;
    const isCustomer =
      trip.passenger_id === user.id
      || (customerRecordId != null && trip.passenger_id === customerRecordId);

    if (!isCustomer) {
      return errorResponse("FORBIDDEN", "Not your trip", 403);
    }
    if (requestedCustomerId && ![user.id, customerRecordId, trip.passenger_id].filter(Boolean).includes(requestedCustomerId)) {
      return errorResponse("CUSTOMER_MISMATCH", "Customer does not match this trip", 403);
    }
    if (requestedTripId && requestedTripId !== trip.id) {
      return errorResponse("TRIP_MISMATCH", "Counter offer trip does not match active ride offer", 409);
    }
    if (requestedDriverId && requestedDriverId !== offer.driver_id) {
      return errorResponse("LOCKED_DRIVER_MISMATCH", "Counter offer driver does not match locked driver", 409);
    }

    const adminCountdown = await loadServiceAreaNegotiationCountdown(
      supabase,
      (trip as { service_area_id?: string | null }).service_area_id,
    );

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

    const tripNegotiationDisabled =
      (trip as { negotiation_disabled?: boolean }).negotiation_disabled === true
      || (trip as { negotiation_allowed?: boolean }).negotiation_allowed === false;
    if (tripNegotiationDisabled && action === "COUNTER") {
      return errorResponse(
        "DISABLED",
        "Fare negotiation is not available for this trip",
        403,
      );
    }

    if (offer.negotiation_status === "declined_customer_awaiting_driver") {
      const baseFarePence = resolveNegotiationBaseFarePence(trip);
      return successResponse({
        success: true,
        action: "DRIVER_SECOND_CHANCE",
        trip_id: trip.id,
        base_fare_pence: baseFarePence,
        negotiation_status: "declined_customer_awaiting_driver",
        negotiation_expires_at:
          offer.grace_window_expires_at
          ?? offer.negotiation_expires_at
          ?? offer.driver_respond_by,
        original_fare_pence: baseFarePence,
        message: "Driver has one chance to accept the original fare",
      });
    }

    if (!isAwaitingCustomerDecision(offer)) {
      return errorResponse(
        "INVALID_STATE",
        `Offer is not awaiting customer decision (status=${offer.status}, negotiation=${offer.negotiation_status})`,
        409,
      );
    }

    // Heal rows where driver preset landed but negotiation_status was not set.
    if (
      offer.driver_offer_fare > 0
      && offer.negotiation_status !== "waiting_customer"
      && offer.negotiation_status !== "waiting_driver_final"
      && offer.negotiation_status !== "declined_customer_awaiting_driver"
      && (offer.status === "pending" || offer.status === "countered")
    ) {
      const healedBy =
        offer.customer_respond_by
        ?? offer.negotiation_expires_at
        ?? resolveNegotiationDeadlineIso({
          countdownSeconds: adminCountdown,
        });
      await supabase
        .from("ride_offers")
        .update({
          negotiation_status: "waiting_customer",
          customer_respond_by: offer.customer_respond_by ?? healedBy,
          negotiation_expires_at: offer.negotiation_expires_at ?? healedBy,
          expires_at: offer.negotiation_expires_at ?? healedBy,
          status: "countered",
          updated_at: new Date().toISOString(),
        })
        .eq("id", offer_id);
      offer.negotiation_status = "waiting_customer";
      offer.customer_respond_by = offer.customer_respond_by ?? healedBy;
      offer.negotiation_expires_at = offer.negotiation_expires_at ?? healedBy;
      offer.status = "countered";
    }
    const respondByIso =
      (offer as { negotiation_expires_at?: string | null }).negotiation_expires_at
      ?? offer.customer_respond_by;
    const respondByMs = respondByIso ? new Date(respondByIso).getTime() : null;
    if (respondByMs != null && respondByMs < Date.now() - 5000) {
      const secondChance = await enterDriverSecondChanceAtOriginalFare(supabase, {
        offer_id,
        trip_id: trip.id,
        driver_id: offer.driver_id,
        reason: "timeout_customer",
        trip,
      });
      return successResponse({
        success: true,
        action: "DRIVER_SECOND_CHANCE",
        trip_id: trip.id,
        negotiation_status: "declined_customer_awaiting_driver",
        negotiation_expires_at: secondChance.negotiation_expires_at,
        original_fare_pence: secondChance.original_fare_pence,
        message: "Driver has one chance to accept the original fare",
      });
    }

    if (action === "ACCEPT" || action === "COUNTER" || action === "DECLINE") {
      const submittedAtIso = new Date().toISOString();
      const claimed = await claimCustomerNegotiationDecision(supabase, offer_id, submittedAtIso);
      if (!claimed.ok) {
        if (claimed.reason === "expired") {
          const secondChance = await enterDriverSecondChanceAtOriginalFare(supabase, {
            offer_id,
            trip_id: trip.id,
            driver_id: offer.driver_id,
            reason: "timeout_customer",
            trip,
          });
          return successResponse({
            success: true,
            action: "DRIVER_SECOND_CHANCE",
            trip_id: trip.id,
            negotiation_status: "declined_customer_awaiting_driver",
            negotiation_expires_at: secondChance.negotiation_expires_at,
            original_fare_pence: secondChance.original_fare_pence,
            message: "Driver has one chance to accept the original fare",
          });
        }
        return errorResponse(
          "INVALID_STATE",
          `Offer is not awaiting customer decision (status=${offer.status}, negotiation=${offer.negotiation_status})`,
          409,
        );
      }
    }

    if (action === "ACCEPT") {
      const finalFarePence = offer.driver_offer_fare;
      if (typeof finalFarePence !== "number" || finalFarePence <= 0) {
        return errorResponse("INVALID_STATE", "Driver offer fare missing", 409);
      }

      const cover = await ensureNegotiationPayableAuthorised({
        supabase,
        tripId: trip.id,
        requiredFarePence: finalFarePence,
        owner: `negotiation_accept_y:${trip.id}:${offer_id}`,
      });
      if (!cover.ok) {
        return errorResponse(cover.code, cover.message, cover.status);
      }

      // Same atomic assignment path as driver Accept — supports countered preset offers.
      const { data: acceptResult, error: acceptErr } = await supabase.rpc("accept_ride_offer", {
        p_offer_id: offer_id,
        p_driver_id: offer.driver_id,
      });
      const acceptErrorMessage = acceptErr?.message ?? null;

      if (acceptErr) {
        console.error("[customer-fare-decision] accept_ride_offer error:", acceptErr);
        if (isPaymentGateAcceptFailure(acceptErrorMessage)) {
          return errorResponse(
            NEGOTIATION_PAYABLE_INSUFFICIENT_CODE,
            NEGOTIATION_PAYABLE_INSUFFICIENT_MESSAGE,
            409,
          );
        }
        return errorResponse("UPDATE_FAILED", acceptErrorMessage ?? "accept_ride_offer failed", 500);
      }
      let assigned = acceptResult?.success === true;
      if (!assigned && !acceptErr) {
        const { data: tripRow } = await supabase
          .from("trips")
          .select("driver_id, confirmed_driver_id, status")
          .eq("id", trip.id)
          .maybeSingle();
        const st = tripRow?.status ?? "";
        assigned = !!(
          tripRow?.driver_id
          && ["confirmed", "accepted", "driver_assigned", "en_route", "en_route_to_pickup", "driver_en_route"].includes(st)
        );
      }
      if (!assigned) {
        const errCode = acceptErrorMessage?.includes("offer_expired")
          ? "OFFER_EXPIRED"
          : (acceptResult as Record<string, unknown> | null)?.error ?? "ACCEPT_FAILED";
        return errorResponse(
          String(errCode),
          acceptErrorMessage ?? String((acceptResult as Record<string, unknown> | null)?.message ?? "Failed to assign driver"),
          errCode === "OFFER_EXPIRED" ? 410 : 409,
        );
      }

      console.log("[customer-fare-decision] NEGOTIATED_ACCEPT_STARTED", {
        trip_id: trip.id,
        offer_id,
        driver_id: offer.driver_id,
      });
      console.log("NEGOTIATION_CUSTOMER_ACCEPTED", {
        trip_id: trip.id,
        offer_id,
        driver_id: offer.driver_id,
        final_fare_pence: finalFarePence,
      });

      const finalize = await finalizeRideAssignmentSideEffects(supabase, {
        tripId: trip.id,
        offerId: offer_id,
        driverId: offer.driver_id,
        source: "edge_customer_fare_decision",
        fareSource: "negotiated_offer",
        acceptedVia: "accept_ride_offer",
      });

      const tripAfterAccept = finalize.snapshot;

      console.log("[customer-fare-decision] NEGOTIATION_RESOLVED_DRIVER", {
        trip_id: trip.id,
        offer_id,
        driver_id: offer.driver_id,
        final_fare_pence: tripAfterAccept?.final_fare_pence ?? finalFarePence,
        fare_source: tripAfterAccept?.fare_source ?? "negotiated_offer",
        commission_pence: tripAfterAccept?.commission_pence,
        driver_net_pence: tripAfterAccept?.driver_net_pence,
      });
      console.log("[customer-fare-decision] FINAL_FARE_SET", {
        trip_id: trip.id,
        final_fare_pence: tripAfterAccept?.final_fare_pence ?? finalFarePence,
      });
      if (tripAfterAccept?.commission_pence != null) {
        console.log("[customer-fare-decision] COMMISSION_RECALCULATED", {
          trip_id: trip.id,
          commission_pence: tripAfterAccept.commission_pence,
          driver_net_pence: tripAfterAccept.driver_net_pence,
        });
      }

      if (!finalize.ok) {
        // accept_ride_offer already committed fare + assignment. A 500 here
        // invited a second Accept mutation after the trip was already assigned.
        console.error("[customer-fare-decision] finalize assignment incomplete", finalize);
      }

      await supabase.rpc("log_audit_event", {
        p_event_type: "customer_accepted_fare",
        p_user_id: user.id,
        p_trip_id: trip.id,
        p_details: {
          offer_id,
          accepted_fare_pence: finalFarePence,
          fare_source: "negotiated_offer",
          assigned_via: "accept_ride_offer",
        },
      });

      try {
        await postDriverNegotiationPush({
          driverId: offer.driver_id,
          type: "NEGOTIATION_UPDATE",
          title: OFFER_ACCEPTED_ASSIGNED_TITLE,
          body: OFFER_ACCEPTED_ASSIGNED_BODY,
          data: {
            type: "NEGOTIATION_UPDATE",
            notificationType: "offer_accepted_assigned",
            offer_id,
            trip_id: trip.id,
          },
        }, "accept");
      } catch (pushErr) {
        console.warn("[customer-fare-decision] accept driver push failed:", pushErr);
      }

      return successResponse(assignedNegotiationSuccessBody({
        tripId: trip.id,
        offerId: offer_id,
        driverId: offer.driver_id,
        snapshot: finalize.snapshot ?? null,
        fallbackFarePence: finalFarePence,
        fallbackFareSource: "negotiated_offer",
      }));
    }

    if (action === "DECLINE") {
      const secondChance = await enterDriverSecondChanceAtOriginalFare(supabase, {
        offer_id,
        trip_id: trip.id,
        driver_id: offer.driver_id,
        reason: "decline",
        trip,
      });
      const baseFarePence =
        secondChance.original_fare_pence ?? resolveNegotiationBaseFarePence(trip);

      await supabase.rpc("log_audit_event", {
        p_event_type: "customer_declined_fare",
        p_user_id: user.id,
        p_trip_id: trip.id,
        p_details: {
          offer_id,
          driver_id: offer.driver_id,
          base_fare_pence: baseFarePence,
          second_chance: true,
          negotiation_expires_at: secondChance.negotiation_expires_at,
        },
      });

      return successResponse({
        success: true,
        action: "DRIVER_SECOND_CHANCE",
        trip_id: trip.id,
        base_fare_pence: baseFarePence,
        negotiation_status: "declined_customer_awaiting_driver",
        negotiation_expires_at: secondChance.negotiation_expires_at,
        original_fare_pence: baseFarePence,
        message: "Driver has one chance to accept the original fare",
      });
    }

    if (action === "COUNTER") {
      // Customer selects one of the remaining preset options (not the driver's selected fare)
      if (!Number.isFinite(selected_fare_pence) || selected_fare_pence <= 0) {
        return errorResponse("VALIDATION_ERROR", "selected_fare_pence required for COUNTER", 400);
      }
      console.log("CUSTOMER_COUNTER_PAYLOAD", {
        ride_id: requestedTripId ?? trip.id,
        trip_id: requestedTripId ?? trip.id,
        ride_offer_id: offer_id,
        negotiation_id: offer_id,
        customer_id: requestedCustomerId ?? customerRecordId ?? user.id,
        driver_id: requestedDriverId ?? offer.driver_id,
        locked_driver_id: requestedDriverId ?? offer.driver_id,
        counter_offer_fare: selected_fare_pence,
        selected_preset_key,
        action,
      });

      if (offer.negotiation_status !== "waiting_customer") {
        return errorResponse(
          "INVALID_STATE",
          `Offer is not awaiting customer counter (negotiation=${offer.negotiation_status})`,
          409,
        );
      }

      const lockedDriverId =
        (trip as { negotiation_owner_driver_id?: string | null }).negotiation_owner_driver_id
        ?? (trip as { current_offer_driver_id?: string | null }).current_offer_driver_id
        ?? null;
      if (lockedDriverId && lockedDriverId !== offer.driver_id) {
        return errorResponse(
          "LOCKED_DRIVER_MISMATCH",
          "This offer is no longer the locked driver offer",
          409,
        );
      }

      const counterPresetOptions = extractCounterPresetOptions(offer);
      const validOptions = extractCounterFareOptions(offer);
      const driverFare = offer.driver_offer_fare ?? 0;
      let matchingPreset = counterPresetOptions.find((option) =>
        faresMatchPence(option.grossFarePence, selected_fare_pence)
      );
      if (selected_preset_key) {
        const keyMatch = counterPresetOptions.find((option) => option.key === selected_preset_key);
        if (!keyMatch || !faresMatchPence(keyMatch.grossFarePence, selected_fare_pence)) {
          return errorResponse(
            "INVALID_PRESET_KEY",
            "Selected preset key does not match the counter fare",
            400,
            { selected_preset_key, valid_options: counterPresetOptions },
          );
        }
        matchingPreset = keyMatch;
      }
      let fareOk = !!matchingPreset;
      if (!fareOk && validOptions.length > 0) {
        const closest = validOptions.reduce((best, n) =>
          Math.abs(n - selected_fare_pence) < Math.abs(best - selected_fare_pence) ? n : best
        );
        fareOk = Math.abs(closest - selected_fare_pence) <= 2;
        matchingPreset = counterPresetOptions.find((option) => faresMatchPence(option.grossFarePence, closest));
      }
      if (!fareOk) {
        return errorResponse(
          "INVALID_FARE",
          validOptions.length > 0
            ? `Selected fare must be one of: ${validOptions.join(", ")} pence`
            : "Selected fare is not a valid counter option",
          400,
          { valid_options: validOptions },
        );
      }

      // Counter cannot be the same as driver's offer
      if (faresMatchPence(selected_fare_pence, driverFare)) {
        return errorResponse(
          "INVALID_COUNTER",
          "Counter-offer cannot equal the driver's offer. Use ACCEPT instead.",
          400
        );
      }

      const cover = await ensureNegotiationPayableAuthorised({
        supabase,
        tripId: trip.id,
        requiredFarePence: selected_fare_pence,
        owner: `negotiation_counter_z:${trip.id}:${offer_id}`,
      });
      if (!cover.ok) {
        return errorResponse(cover.code, cover.message, cover.status);
      }

      console.log("[customer-fare-decision] CUSTOMER_SEND_COUNTER", {
        ride_id: trip.id,
        trip_id: trip.id,
        ride_offer_id: offer_id,
        negotiation_id: offer_id,
        customer_id: requestedCustomerId ?? customerRecordId ?? user.id,
        driver_id: offer.driver_id,
        locked_driver_id: offer.driver_id,
        counter_fare: selected_fare_pence,
        counter_offer_fare: selected_fare_pence,
        selected_preset_key: selected_preset_key ?? matchingPreset?.key ?? null,
        countdown_seconds: adminCountdown,
      });

      const { data: counterRpc, error: counterRpcErr } = await supabase.rpc(
        "customer_counter_ride_offer",
        {
          p_offer_id: offer_id,
          p_selected_fare_pence: selected_fare_pence,
          p_actor_user_id: user.id,
          p_customer_id: customerRecordId,
        },
      );
      if (counterRpcErr || counterRpc?.success !== true) {
        console.error("[customer-fare-decision] customer_counter_ride_offer failed:", counterRpcErr, counterRpc);
        const mapped = mapCustomerCounterRideOfferError(counterRpcErr, counterRpc);
        return errorResponse(mapped.code, mapped.message, mapped.status);
      }

      const driverRespondBy =
        typeof counterRpc.driver_respond_by === "string"
          ? counterRpc.driver_respond_by
          : resolveNegotiationDeadlineIso({ countdownSeconds: adminCountdown });
      const updatedOffer = {
        id: offer_id,
        trip_id: trip.id,
        driver_id: offer.driver_id,
        status: "countered",
        negotiation_status: "waiting_driver_final",
        customer_counter_fare: selected_fare_pence,
        driver_respond_by: driverRespondBy,
      };

      try {
        const { data: tripForNet } = await supabase
          .from("trips")
          .select("commission_pct, driver_tier_commission_percent, currency_code")
          .eq("id", trip.id)
          .maybeSingle();
        const commission = Number(
          tripForNet?.driver_tier_commission_percent ?? tripForNet?.commission_pct ?? 0,
        );
        const { data: offerSnapRow } = await supabase
          .from("ride_offers")
          .select("offer_snapshot")
          .eq("id", offer_id)
          .maybeSingle();
        if (offerSnapRow?.offer_snapshot && Number.isFinite(commission) && commission >= 0) {
          const restamped = enrichOfferSnapshotDriverNet(
            offerSnapRow.offer_snapshot as Record<string, unknown>,
            {},
            commission,
            selected_fare_pence,
            typeof tripForNet?.currency_code === "string" ? tripForNet.currency_code : null,
          );
          await supabase
            .from("ride_offers")
            .update({ offer_snapshot: restamped, updated_at: new Date().toISOString() })
            .eq("id", offer_id);
        }
      } catch (netErr) {
        console.warn("[customer-fare-decision] driver-net restamp failed:", netErr);
      }

      console.log("[customer-fare-decision] DB_AFTER_COUNTER", {
        negotiation_id: updatedOffer.id,
        status: updatedOffer.status,
        negotiation_status: updatedOffer.negotiation_status,
        counter_fare: updatedOffer.customer_counter_fare,
        driver_id: updatedOffer.driver_id,
        expires_at: driverRespondBy,
      });

      await supabase.rpc("log_audit_event", {
        p_event_type: "customer_counter_offer",
        p_user_id: user.id,
        p_trip_id: trip.id,
        p_details: {
          offer_id,
          selected_fare_pence,
          driver_respond_by: driverRespondBy,
          event: "customer_counter_offer_received",
          driver_id: offer.driver_id,
        },
      });

      const { data: broadcastRow } = await supabase
        .from("ride_offers")
        .select(
          "id, trip_id, driver_id, status, negotiation_status, customer_counter_fare, driver_offer_fare, driver_respond_by, negotiation_expires_at, expires_at, offer_options, customer_respond_by, grace_window_expires_at",
        )
        .eq("id", offer_id)
        .single();

      if (!broadcastRow) {
        console.error("[customer-fare-decision] COUNTER broadcast row missing after update", {
          offer_id,
          trip_id: trip.id,
        });
        return errorResponse("BROADCAST_ROW_MISSING", "Counter-offer persisted but could not be verified", 500);
      }

      const broadcastDelivered = await broadcastCustomerCounterOffer(supabase, {
        id: broadcastRow.id,
        trip_id: broadcastRow.trip_id,
        driver_id: broadcastRow.driver_id,
        status: broadcastRow.status,
        negotiation_status: broadcastRow.negotiation_status,
        customer_counter_fare: broadcastRow.customer_counter_fare,
        driver_offer_fare: broadcastRow.driver_offer_fare,
        driver_respond_by: broadcastRow.driver_respond_by,
        expires_at: broadcastRow.expires_at ?? driverRespondBy,
        negotiation_expires_at:
          (broadcastRow as { negotiation_expires_at?: string }).negotiation_expires_at
          ?? driverRespondBy,
        offer_options: broadcastRow.offer_options,
        customer_respond_by: broadcastRow.customer_respond_by,
        grace_window_expires_at: broadcastRow.grace_window_expires_at,
      });

      if (!broadcastDelivered) {
        console.error("[customer-fare-decision] COUNTER driver broadcast failed (offer already committed)", {
          offer_id,
          trip_id: trip.id,
          driver_id: broadcastRow.driver_id,
        });
      }

      try {
          const pushData = buildDriverNegotiationPushData({
            offer_id: broadcastRow.id,
            trip_id: broadcastRow.trip_id,
            negotiation_status: broadcastRow.negotiation_status,
            negotiation_expires_at:
              (broadcastRow as { negotiation_expires_at?: string }).negotiation_expires_at
              ?? broadcastRow.driver_respond_by,
            customer_counter_fare: broadcastRow.customer_counter_fare,
            expires_at: broadcastRow.expires_at ?? broadcastRow.driver_respond_by,
            notificationType: "customer_counter_offer",
          });
          await postDriverNegotiationPush({
            driverId: broadcastRow.driver_id,
            type: "NEGOTIATION_UPDATE",
            title: "Customer counter offer",
            body: customerCounterOfferPushBody(selected_fare_pence),
            data: pushData,
          }, "counter");
        } catch (pushErr) {
          console.warn("[customer-fare-decision] driver negotiation push failed:", pushErr);
        }

      console.log("CUSTOMER_COUNTER_EDGE_SUCCESS", {
        ride_id: trip.id,
        negotiation_id: offer_id,
        driver_id: offer.driver_id,
        counter_fare: selected_fare_pence,
        driver_respond_by: driverRespondBy,
        broadcast_sent: broadcastDelivered,
      });

      return successResponse({
        success: true,
        action: "COUNTERED",
        customer_counter_fare: selected_fare_pence,
        driver_respond_by: driverRespondBy,
        negotiation_expires_at: driverRespondBy,
        expires_at: driverRespondBy,
      });
    }

    return errorResponse("INVALID_ACTION", "Unknown action", 400);
  } catch (err) {
    console.error("[customer-fare-decision] Error:", err);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
