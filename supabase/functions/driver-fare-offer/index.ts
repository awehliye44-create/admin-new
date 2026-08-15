/**
 * LOCKED — driver-fare-offer edge (keep in sync with onecab-comfy-ride copy).
 * See drive-hub-buddy/.cursor/rules/preset-negotiation-workflow.mdc
 *
 * Flow: 3 preset chips → faresMatchPence validation → waiting_customer.
 * Base fare: resolveNegotiationBaseFarePence. Do not require exact pre-enrich pence match.
 *
 * POST body: { offer_id, driver_id, selected_fare_pence, selected_offer_key? }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  handleCORSPreflight,
  jsonHeaders,
  securityHeaders,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  isValidUUID,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import {
  buildNegotiationFromPresetOptions,
  deriveOfferOptionsPence,
  extractPresetOptionsFromOffer,
  faresMatchPence,
  parseOfferSnapshot,
} from "../_shared/presetOptionsCanonical.ts";
import { resolveNegotiationBaseFarePence } from "../_shared/negotiationBaseFare.ts";
import {
  CUSTOMER_NEW_FARE_OFFER_TITLE,
  customerNewFareOfferBody,
} from "../_shared/negotiationPushCopy.ts";
import { presetNegotiationOfferIneligibility, presetNegotiationSourceIneligibility } from "../_shared/presetNegotiationEligibility.ts";
import {
  loadServiceAreaNegotiationCountdown,
  resolveNegotiationDeadlineIso,
} from "../_shared/negotiation-deadline.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://thazislrdkjpvvghtvzo.supabase.co";
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function isFareValidForPresetSend(
  selectedPence: number,
  presetOptions: ReturnType<typeof extractPresetOptionsFromOffer>,
  selectedKey: string | null | undefined,
): boolean {
  if (presetOptions.some((o) => o.key === selectedKey && selectedKey)) return true;
  return presetOptions.some((o) => faresMatchPence(o.grossFarePence, selectedPence));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  const ip = getClientIP(req);
  const rl = checkRateLimit(ip, { limit: 30, windowMs: 60000, keyPrefix: "driver-fare-offer" });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    // Auth
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
    const { offer_id, driver_id, selected_fare_pence, selected_offer_key } = body;

    console.log("[driver-fare-offer] SEND_PRESET_OFFER_REQUEST", {
      offer_id,
      driver_id,
      selected_fare_pence,
      selected_offer_key: selected_offer_key ?? null,
    });

    // Validate inputs
    if (!isValidUUID(offer_id)) return errorResponse("VALIDATION_ERROR", "Invalid offer_id", 400);
    if (!isValidUUID(driver_id)) return errorResponse("VALIDATION_ERROR", "Invalid driver_id", 400);
    if (typeof selected_fare_pence !== "number" || selected_fare_pence <= 0) {
      return errorResponse("VALIDATION_ERROR", "Invalid selected_fare_pence", 400);
    }

    // Verify driver belongs to user
    const { data: driver, error: driverErr } = await supabase
      .from("drivers")
      .select("id, user_id")
      .eq("id", driver_id)
      .single();

    if (driverErr || !driver) {
      return errorResponse("NOT_FOUND", "Driver not found", 404);
    }
    if (driver.user_id !== user.id) return errorResponse("FORBIDDEN", "Not your driver profile", 403);

    // Get offer with trip including vehicle_type_id, service_area_id, and current negotiation owner
    const { data: offer, error: offerErr } = await supabase
      .from("ride_offers")
      .select("*, trips(id, estimated_fare, fare, fare_breakdown, base_fare_pence, service_area_id, vehicle_type_id, status, negotiation_locked_until, negotiation_owner_driver_id, negotiation_disabled, negotiation_allowed, dispatch_status, is_scheduled, dispatch_mode, trip_type, corporate_account_id, booking_source)")
      .eq("id", offer_id)
      .eq("driver_id", driver_id)
      .single();

    if (offerErr || !offer) return errorResponse("NOT_FOUND", "Offer not found", 404);
    if (offer.status !== "pending") {
      return errorResponse("INVALID_STATE", `Offer is ${offer.status}, not pending`, 409);
    }
    if (new Date(offer.expires_at) < new Date()) {
      return errorResponse("EXPIRED", "Offer has expired", 410);
    }

    const trip = offer.trips;
    if (!trip || ["completed", "cancelled", "expired", "declined"].includes(trip.status)) {
      console.error("[driver-fare-offer] TRIP_STATUS_UNAVAILABLE", {
        offer_id,
        driver_id,
        trip_id: trip?.id ?? null,
        trip_status: trip?.status ?? "NO_TRIP_JOIN",
        dispatch_status: (trip as any)?.dispatch_status ?? null,
        current_broadcast_round: (trip as any)?.current_broadcast_round ?? null,
        offer_status: offer.status,
        offer_expires_at: offer.expires_at,
      });
      return errorResponse("TRIP_EXPIRED", "This ride has expired — no drivers were found in time", 409);
    }

    if (
      (trip as { negotiation_disabled?: boolean }).negotiation_disabled === true
      || (trip as { negotiation_allowed?: boolean }).negotiation_allowed === false
    ) {
      console.log("[driver-fare-offer] SEND_PRESET_OFFER_ERROR negotiation_disabled_for_trip", trip.id);
      return errorResponse("DISABLED", "Fare negotiation is not available for this trip", 403);
    }

    // Hard rule: stacked rides disable negotiations — no fare offers on stacked offers.
    const stackedBlock = presetNegotiationOfferIneligibility(offer);
    if (stackedBlock) {
      console.log("[driver-fare-offer] SEND_PRESET_OFFER_ERROR stacked_ride_no_negotiation", {
        offer_id,
        trip_id: trip.id,
        reason: stackedBlock.reason,
      });
      return errorResponse("DISABLED", stackedBlock.message, 403, { reason: stackedBlock.reason });
    }

    // negotiation_locked_until is the customer respond deadline — only block another driver.
    if (
      trip.negotiation_locked_until
      && new Date(trip.negotiation_locked_until) > new Date()
      && trip.negotiation_owner_driver_id
      && trip.negotiation_owner_driver_id !== driver_id
    ) {
      return errorResponse("LOCKED", "Another driver is negotiating this trip", 409, {
        locked_until: trip.negotiation_locked_until,
      });
    }

    // First-write-wins: refuse if another driver already owns the negotiation for this trip
    if (trip.negotiation_owner_driver_id && trip.negotiation_owner_driver_id !== driver_id) {
      console.error("[driver-fare-offer] NEGOTIATION_OWNER_CONFLICT", {
        offer_id,
        driver_id,
        trip_id: trip.id,
        owner_driver_id: trip.negotiation_owner_driver_id,
        trip_status: trip.status,
      });
      return errorResponse("LOCKED", "Another driver is already negotiating this ride", 409, {
        owner_driver_id: trip.negotiation_owner_driver_id,
      });
    }

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

    let offerForPresets = offer;
    let presetOptions = extractPresetOptionsFromOffer(offerForPresets);
    if (presetOptions.length < 3) {
      console.log("[driver-fare-offer] preset_options missing — calling enrich_ride_offer_presets", {
        count: presetOptions.length,
        offer_id,
        trip_id: trip.id,
      });
      const { data: enrichResult, error: enrichErr } = await supabase.rpc(
        "enrich_ride_offer_presets",
        { p_trip_id: trip.id },
      );
      if (enrichErr) {
        console.warn("[driver-fare-offer] enrich_ride_offer_presets failed:", enrichErr.message);
      } else {
        console.log("[driver-fare-offer] enrich_ride_offer_presets", enrichResult);
      }
      const { data: refreshedOffer } = await supabase
        .from("ride_offers")
        .select("*, trips(id, status, negotiation_locked_until, negotiation_owner_driver_id, negotiation_disabled, negotiation_allowed, dispatch_status, is_scheduled, dispatch_mode, trip_type, corporate_account_id, booking_source)")
        .eq("id", offer_id)
        .eq("driver_id", driver_id)
        .single();
      if (refreshedOffer) {
        offerForPresets = refreshedOffer;
        presetOptions = extractPresetOptionsFromOffer(offerForPresets);
      }
    }
    if (presetOptions.length < 3) {
      return errorResponse(
        "CONFIGURATION_ERROR",
        "Preset fare options are not configured for this area — contact support",
        409,
        { preset_count: presetOptions.length },
      );
    }

    if (!isFareValidForPresetSend(selected_fare_pence, presetOptions, selected_offer_key)) {
      const validPence = presetOptions.map((o) => o.grossFarePence);
      console.log("[driver-fare-offer] SEND_PRESET_OFFER_ERROR invalid_fare", {
        selected_fare_pence,
        valid_options: validPence,
        preset_keys: presetOptions.map((o) => o.key),
      });
      return errorResponse(
        "INVALID_FARE",
        `Selected fare must match a preset option`,
        400,
        { preset_options: presetOptions },
      );
    }

    const baseFarePence = resolveNegotiationBaseFarePence(trip);
    const uniqueOptions = deriveOfferOptionsPence(presetOptions);

    {
      const settingsFields = "fare_negotiation_enabled";
      let dispSettings: { fare_negotiation_enabled?: boolean } | null = null;
      if (trip.service_area_id) {
        const { data: areaSettings } = await supabase
          .from("dispatch_settings")
          .select(settingsFields)
          .eq("service_area_id", trip.service_area_id)
          .maybeSingle();
        dispSettings = areaSettings;
      }
      if (!dispSettings) {
        const { data: globalSettings } = await supabase
          .from("dispatch_settings")
          .select(settingsFields)
          .is("service_area_id", null)
          .maybeSingle();
        dispSettings = globalSettings;
      }
      if (dispSettings?.fare_negotiation_enabled === false) {
        return errorResponse("DISABLED", "Fare negotiation is not enabled for this service area", 403);
      }
    }

    const existingSnap = parseOfferSnapshot(offerForPresets.offer_snapshot) ?? {};
    const { selectedOffer, remainingOptions } = buildNegotiationFromPresetOptions(
      presetOptions,
      selected_fare_pence,
      selected_offer_key ?? null,
    );
    const adminCountdown = await loadServiceAreaNegotiationCountdown(
      supabase,
      (trip as { service_area_id?: string | null }).service_area_id,
    );
    const snapshotCountdown = Number(
      existingSnap.countdown_seconds ?? existingSnap.presetCountdownSeconds,
    );
    const resolvedCountdown =
      adminCountdown ??
      (Number.isFinite(snapshotCountdown) && snapshotCountdown >= 5
        ? Math.round(snapshotCountdown)
        : null);
    const customerRespondByDefault = resolveNegotiationDeadlineIso({
      countdownSeconds: resolvedCountdown,
    });
    const customerRespondSeconds = Math.min(
      120,
      Math.max(
        5,
        Math.ceil((Date.parse(customerRespondByDefault) - Date.now()) / 1000),
      ),
    );
    let customerRespondBy = customerRespondByDefault;
    const snapshotForOffer = {
      ...existingSnap,
      baseFarePence,
      preset_options: presetOptions,
      selectedOfferKey: selected_offer_key ?? selectedOffer.key,
      selectedOffer,
      remainingOptions,
      negotiationLocked: true,
      countdown_auto_select: false,
      countdown_seconds: resolvedCountdown ?? customerRespondSeconds,
      presetCountdownSeconds: resolvedCountdown ?? customerRespondSeconds,
    };

    // Primary path: atomic DB RPC (no strict trip.status filter — avoids CLAIM_FAILED on fresh offers).
    const { data: rpcResult, error: rpcErr } = await supabase.rpc("driver_send_preset_offer", {
      p_offer_id: offer_id,
      p_selected_total_fare_pence: selected_fare_pence,
      p_allowed_total_fares_pence: uniqueOptions,
      p_customer_respond_seconds: customerRespondSeconds,
    });

    if (rpcErr) {
      const rpcMsg = rpcErr.message ?? String(rpcErr);
      console.error("[driver-fare-offer] SEND_PRESET_OFFER_ERROR rpc_failed", rpcMsg);

      if (rpcMsg.includes("negotiation_disabled")) {
        return errorResponse("DISABLED", "Fare negotiation is not available for this trip", 403);
      }
      if (
        rpcMsg.includes("ineligible_scheduled")
        || rpcMsg.includes("ineligible_corporate")
        || rpcMsg.includes("ineligible_whatsapp")
        || rpcMsg.includes("ineligible_stacked")
      ) {
        const stackedBlock = presetNegotiationOfferIneligibility(offer);
        if (stackedBlock) {
          return errorResponse("DISABLED", stackedBlock.message, 403, { reason: stackedBlock.reason });
        }
        const block = presetNegotiationSourceIneligibility(trip as {
          is_scheduled?: boolean | null;
          dispatch_mode?: string | null;
          trip_type?: string | null;
          corporate_account_id?: string | null;
          booking_source?: string | null;
        });
        return errorResponse(
          "DISABLED",
          block?.message ?? "Fare negotiation is not available for this trip",
          403,
          { reason: block?.reason ?? "ineligible_scheduled" },
        );
      }
      if (rpcMsg.includes("offer_not_pending") || rpcMsg.includes("offer_not_found")) {
        return errorResponse("INVALID_STATE", "Offer is no longer pending", 409);
      }
      if (rpcMsg.includes("trip_already_assigned")) {
        return errorResponse("INVALID_STATE", "Trip is no longer available", 409);
      }

      // Manual fallback when RPC is unavailable or races
      const ownerIsSelf = trip.negotiation_owner_driver_id === driver_id;
      const tripClaimable =
        ["pending", "searching", "offered", "broadcasting", "offering", "searching_new_driver", "negotiating"]
          .includes(trip.status);

      if (!tripClaimable && !(ownerIsSelf && trip.status === "negotiating")) {
        console.error("[driver-fare-offer] TRIP_NOT_CLAIMABLE", {
          offer_id,
          trip_id: trip.id,
          trip_status: trip.status,
        });
        return errorResponse("TRIP_NOT_CLAIMABLE", "This ride is no longer accepting offers", 409);
      }

      if (!ownerIsSelf) {
        const { data: claimedTrips, error: claimErr } = await supabase
          .from("trips")
          .update({
            status: "negotiating",
            negotiation_owner_driver_id: driver_id,
            dispatch_status: "paused",
            broadcast_enabled: false,
            current_offer_driver_id: driver_id,
            negotiation_locked_until: customerRespondByDefault,
            updated_at: new Date().toISOString(),
          })
          .eq("id", trip.id)
          .or(`negotiation_owner_driver_id.is.null,negotiation_owner_driver_id.eq.${driver_id}`)
          .in("status", [
            "pending",
            "searching",
            "offered",
            "broadcasting",
            "offering",
            "searching_new_driver",
            "negotiating",
          ])
          .select("id");

        if (claimErr || !claimedTrips?.length) {
          const { data: tripNow } = await supabase
            .from("trips")
            .select("status, negotiation_owner_driver_id")
            .eq("id", trip.id)
            .single();
          const reason = tripNow?.status === "expired"
            ? "This ride expired while processing your offer"
            : tripNow?.negotiation_owner_driver_id
              ? "Another driver claimed this ride first"
              : "This ride is no longer available";
          return errorResponse("CLAIM_FAILED", reason, 409);
        }
      }

      await supabase
        .from("ride_offers")
        .update({
          status: "revoked",
          revoked_reason: "negotiation_started",
          updated_at: new Date().toISOString(),
        })
        .eq("trip_id", trip.id)
        .eq("status", "pending")
        .neq("id", offer_id);

      const { data: updatedOffers, error: updateErr } = await supabase
        .from("ride_offers")
        .update({
          status: "countered",
          negotiation_status: "waiting_customer",
          driver_offer_fare: selected_fare_pence,
          offer_options: uniqueOptions,
          offer_snapshot: snapshotForOffer,
          customer_respond_by: customerRespondByDefault,
          driver_respond_by: null,
          negotiation_expires_at: customerRespondByDefault,
          expires_at: customerRespondByDefault,
          delivery_phase: "negotiation",
          updated_at: new Date().toISOString(),
        })
        .eq("id", offer_id)
        .eq("driver_id", driver_id)
        .eq("status", "pending")
        .select("id");

      if (updateErr || !updatedOffers?.length) {
        return errorResponse("UPDATE_FAILED", "Failed to submit fare offer", 500);
      }
      customerRespondBy = customerRespondByDefault;
    } else {
      const rpcPayload = rpcResult as Record<string, unknown> | null;
      if (rpcPayload?.customer_respond_by) {
        customerRespondBy = String(rpcPayload.customer_respond_by);
      }
      const negotiationExpiresAt = String(
        rpcPayload?.negotiation_expires_at ?? customerRespondBy,
      );

      const { error: enrichErr } = await supabase
        .from("ride_offers")
        .update({
          offer_options: uniqueOptions,
          offer_snapshot: snapshotForOffer,
          customer_respond_by: customerRespondBy,
          negotiation_expires_at: negotiationExpiresAt,
          expires_at: negotiationExpiresAt,
          delivery_phase: "negotiation",
          updated_at: new Date().toISOString(),
        })
        .eq("id", offer_id)
        .eq("driver_id", driver_id);

      if (enrichErr) {
        console.warn("[driver-fare-offer] offer enrich after RPC (non-fatal):", enrichErr);
      }
    }

    console.log("[driver-fare-offer] NEGOTIATION_ROW_UPDATED", {
      offer_id,
      trip_id: trip.id,
      negotiation_status: "waiting_customer",
    });

    const { data: verifiedOffer, error: verifyErr } = await supabase
      .from("ride_offers")
      .select("id, negotiation_status, driver_offer_fare, status, updated_at")
      .eq("id", offer_id)
      .maybeSingle();

    if (verifyErr || verifiedOffer?.negotiation_status !== "waiting_customer") {
      console.error("[driver-fare-offer] NEGOTIATION_WAITING_CUSTOMER_VERIFY_FAILED", {
        offer_id,
        trip_id: trip.id,
        verifyErr: verifyErr?.message ?? null,
        negotiation_status: verifiedOffer?.negotiation_status ?? null,
      });
      const repairNow = new Date().toISOString();
      await supabase
        .from("ride_offers")
        .update({
          negotiation_status: "waiting_customer",
          driver_offer_fare: selected_fare_pence,
          status: "countered",
          delivery_phase: "negotiation",
          updated_at: repairNow,
        })
        .eq("id", offer_id)
        .eq("driver_id", driver_id);
    }

    console.log("NEGOTIATION_DRIVER_OFFER_CREATED", {
      offer_id,
      trip_id: trip.id,
      driver_id,
      selected_fare_pence,
    });
    console.log("NEGOTIATION_WAITING_CUSTOMER_SET", {
      offer_id,
      trip_id: trip.id,
      negotiation_status: verifiedOffer?.negotiation_status ?? "waiting_customer",
      driver_offer_fare: verifiedOffer?.driver_offer_fare ?? selected_fare_pence,
    });
    console.log("NEGOTIATION_CUSTOMER_REALTIME_EVENT", {
      event: "ride_offers_update",
      offer_id,
      trip_id: trip.id,
      negotiation_status: "waiting_customer",
    });

    const { data: passengerRow } = await supabase
      .from("trips")
      .select("passenger_id")
      .eq("id", trip.id)
      .maybeSingle();

    console.log("CUSTOMER_OFFER_EVENT_SENT", {
      event: "driver_preset_offer_sent",
      ride_offer_id: offer_id,
      ride_id: trip.id,
      driver_id,
      customer_id: passengerRow?.passenger_id ?? null,
      negotiation_status: "waiting_customer",
    });

    console.log("[driver-fare-offer] CUSTOMER_REALTIME_SENT driver_preset_offer_sent", {
      event: "negotiation_offer_created",
      ride_offer_id: offer_id,
      ride_id: trip.id,
      driver_id,
      customer_id: passengerRow?.passenger_id ?? null,
      selected_offer_key: selected_offer_key ?? null,
      selected_gross_fare: selected_fare_pence,
      preset_options: presetOptions,
      remaining_options: remainingOptions,
      expires_at: customerRespondBy,
      negotiation_status: "waiting_customer",
    });

    if (passengerRow?.passenger_id) {
      try {
        const { resolveCustomerAuthUserId } = await import("../_shared/authoritativeDevicePush.ts");
        const customerAuthUserId = await resolveCustomerAuthUserId(
          supabase,
          passengerRow.passenger_id,
        );
        const pushResp = await fetch(`${supabaseUrl}/functions/v1/send-trip-notification`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            userId: customerAuthUserId,
            tripId: trip.id,
            event: "customer_new_fare_offer",
            title: CUSTOMER_NEW_FARE_OFFER_TITLE,
            body: customerNewFareOfferBody(selected_fare_pence),
            expiresAt: customerRespondBy,
            negotiationExpiresAt: customerRespondBy,
          }),
        });
        console.log("NEGOTIATION_CUSTOMER_PUSH_SENT", {
          offer_id,
          trip_id: trip.id,
          customer_id: passengerRow.passenger_id,
          push_ok: pushResp.ok,
          push_status: pushResp.status,
        });
      } catch (pushErr) {
        console.warn("[driver-fare-offer] customer_new_fare_offer push failed:", pushErr);
      }
    }

    // Audit
    await supabase.rpc("log_audit_event", {
      p_event_type: "driver_fare_offered",
      p_driver_id: driver_id,
      p_trip_id: trip.id,
      p_details: {
        offer_id,
        selected_fare_pence,
        base_fare_pence: baseFarePence,
        offer_options: uniqueOptions,
        preset_options: presetOptions,
        customer_respond_by: customerRespondBy,
      },
    });

    console.log("[driver-fare-offer] SEND_PRESET_OFFER_SUCCESS", {
      offer_id,
      trip_id: trip.id,
      customer_respond_by: customerRespondBy,
    });

    // Fresh negotiation/trip snapshot for UI (no client-invented waiting_customer).
    const [{ data: offerSnap }, { data: tripSnap }] = await Promise.all([
      supabase
        .from("ride_offers")
        .select(
          "id, trip_id, driver_id, status, negotiation_status, driver_offer_fare, customer_counter_fare, customer_respond_by, negotiation_expires_at, expires_at, offer_snapshot",
        )
        .eq("id", offer_id)
        .maybeSingle(),
      supabase
        .from("trips")
        .select(
          "id, status, dispatch_status, driver_id, negotiation_status, negotiation_owner_driver_id, negotiation_locked_until, final_fare_pence, final_customer_fare_pence, updated_at",
        )
        .eq("id", trip.id)
        .maybeSingle(),
    ]);

    return successResponse({
      success: true,
      offer_id,
      trip_id: trip.id,
      selected_fare_pence,
      selected_gross_fare: selected_fare_pence,
      offer_options: uniqueOptions,
      preset_options: presetOptions,
      remaining_options: remainingOptions,
      customer_respond_by: customerRespondBy,
      negotiation_expires_at: customerRespondBy,
      negotiation_status: "waiting_customer",
      event: "driver_preset_offer_sent",
      offer: offerSnap ?? null,
      trip: tripSnap ?? null,
    });
  } catch (err) {
    console.error("[driver-fare-offer] SEND_PRESET_OFFER_ERROR", err);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
