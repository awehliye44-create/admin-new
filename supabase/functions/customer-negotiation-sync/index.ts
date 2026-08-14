/**
 * customer-negotiation-sync – sync customer negotiation deadlines.
 *
 * The customer app calls this when remaining time from the backend deadline
 * hits zero. For final driver response windows, expiry is an automatic reject:
 * exclude this driver and rebroadcast the same trip without opening another
 * negotiation. Never auto-accept.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { finalizeNegotiationFailureAndRebroadcast } from "../_shared/negotiationFailureRematch.ts";
import { presetNegotiationSourceIneligibility } from "../_shared/presetNegotiationEligibility.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing auth" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json() as { offer_id?: string };
    const offerId = body.offer_id;
    if (!offerId) {
      return new Response(JSON.stringify({ error: "offer_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: offer, error: offerErr } = await supabase
      .from("ride_offers")
      .select("id, trip_id, driver_id, status, negotiation_status, customer_respond_by, driver_respond_by, grace_window_expires_at")
      .eq("id", offerId)
      .single();

    if (offerErr || !offer) {
      return new Response(JSON.stringify({ error: "Offer not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: trip } = await supabase
      .from("trips")
      .select("id, passenger_id, customer_id, status, negotiation_owner_driver_id, is_scheduled, dispatch_mode, trip_type, corporate_account_id, booking_source")
      .eq("id", offer.trip_id)
      .single();

    if (!trip) {
      return new Response(JSON.stringify({ error: "Trip not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: customer } = await supabase
      .from("customers")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();

    const isOwner =
      trip.passenger_id === user.id ||
      trip.customer_id === user.id ||
      (customer && (trip.passenger_id === customer.id || trip.customer_id === customer.id));

    if (!isOwner) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sourceBlock = presetNegotiationSourceIneligibility(trip);
    const ns = offer.negotiation_status;
    const liveNegotiation =
      ns === "waiting_customer"
      || ns === "waiting_driver_final"
      || ns === "declined_customer_awaiting_driver";
    if (sourceBlock && !liveNegotiation) {
      return new Response(JSON.stringify({
        success: false,
        error: "DISABLED",
        message: sourceBlock.message,
        reason: sourceBlock.reason,
      }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const alreadyResolved =
      offer.status === "accepted" ||
      offer.status === "revoked" ||
      offer.status === "declined" ||
      offer.status === "expired" ||
      ns === "confirmed" ||
      ns === "timeout_customer" ||
      ns === "timeout_driver" ||
      ns === "declined_driver";

    if (alreadyResolved) {
      // Map terminal negotiation statuses to customer-facing actions
      let action = "already_resolved";
      if (ns === "timeout_customer" || ns === "timeout_driver") {
        action = "negotiation_failed_rebroadcasting";
      } else if (ns === "declined_driver") {
        action = "negotiation_failed_rebroadcasting";
      } else if (offer.status === "accepted" || ns === "confirmed") {
        action = "already_resolved";
      }

      return new Response(JSON.stringify({ success: true, action, trip_id: offer.trip_id }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Customer timeout → check if server has already transitioned to grace
    if (ns === "waiting_customer") {
      const respondByMs = offer.customer_respond_by
        ? new Date(offer.customer_respond_by).getTime()
        : null;

      if (respondByMs && respondByMs > Date.now()) {
        return new Response(JSON.stringify({ success: true, action: "not_expired_yet", trip_id: offer.trip_id }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Timeout = decline: discard £Y, rematch at original £X, exclude this Driver.
      const result = await finalizeNegotiationFailureAndRebroadcast(supabase, {
        tripId: offer.trip_id,
        failedDriverId: offer.driver_id,
        offerId,
        offerTerminalStatus: "expired",
        offerNegotiationStatus: "timeout_customer",
      });
      if (!result.success) {
        return new Response(JSON.stringify({
          success: false,
          error: result.error ?? "Failed to resume driver search",
        }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
        success: true,
        action: "negotiation_failed_rebroadcasting",
        trip_id: result.trip_id ?? offer.trip_id,
        negotiation_disabled: true,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Driver final standard window after customer decline.
    if (ns === "declined_customer_awaiting_driver") {
      const graceMs = offer.grace_window_expires_at
        ? new Date(offer.grace_window_expires_at).getTime()
        : null;
      if (graceMs && graceMs > Date.now()) {
        return new Response(JSON.stringify({
          success: true,
          action: "already_in_grace",
          trip_id: offer.trip_id,
          grace_window_expires_at: offer.grace_window_expires_at,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const result = await finalizeNegotiationFailureAndRebroadcast(supabase, {
        tripId: offer.trip_id,
        failedDriverId: offer.driver_id,
        offerId,
        offerTerminalStatus: "expired",
        offerNegotiationStatus: "timeout_driver",
      });
      if (!result.success) {
        return new Response(JSON.stringify({
          success: false,
          error: result.error ?? "Failed to resume driver search",
        }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
        success: true,
        action: "negotiation_failed_rebroadcasting",
        trip_id: result.trip_id ?? offer.trip_id,
        negotiation_disabled: true,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Waiting for driver to respond to counter — server will finalize on timeout
    if (ns === "waiting_driver_final") {
      const respondByMs = offer.driver_respond_by
        ? new Date(offer.driver_respond_by).getTime()
        : null;

      if (respondByMs && respondByMs > Date.now()) {
        return new Response(JSON.stringify({ success: true, action: "not_expired_yet", trip_id: offer.trip_id }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const result = await finalizeNegotiationFailureAndRebroadcast(supabase, {
        tripId: offer.trip_id,
        failedDriverId: offer.driver_id,
        offerId,
        offerTerminalStatus: "expired",
        offerNegotiationStatus: "timeout_driver",
      });
      if (!result.success) {
        return new Response(JSON.stringify({
          success: false,
          error: result.error ?? "Failed to resume driver search",
        }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
        success: true,
        action: "driver_counter_window_elapsed",
        trip_id: result.trip_id ?? offer.trip_id,
        negotiation_disabled: true,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Trip already moved to searching_new_driver — negotiation was finalized by server
    if (trip.status === "searching_new_driver" || trip.status === "searching") {
      return new Response(JSON.stringify({
        success: true,
        action: "negotiation_failed_rebroadcasting",
        trip_id: offer.trip_id,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, action: "no_op", trip_id: offer.trip_id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("customer-negotiation-sync:", err);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
