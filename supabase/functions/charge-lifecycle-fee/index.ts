/**
 * charge-lifecycle-fee — Revolut-only fee capture via existing terminal disposition.
 *
 * EXISTING CODE REUSED: disposeTerminalTripPayment + fare_pricing_settings
 * DEAD_CODE_TO_DELETE: former Stripe PaymentIntent fee capture path
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { disposeTerminalTripPayment } from "../_shared/terminalTripPaymentDisposition.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const VALID_FEE_TYPES = new Set([
  "cancellation",
  "late_cancel",
  "no_show",
  "waiting_surcharge",
  "arrival_cancellation",
]);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const trip_id = body.trip_id ?? body.tripId;
    const fee_type = String(body.fee_type ?? body.feeType ?? "").trim();
    let amount_pence = Math.max(0, Math.round(Number(body.amount_pence ?? body.amountPence ?? 0)));

    if (!trip_id || !fee_type) {
      return new Response(JSON.stringify({ error: "trip_id and fee_type are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!VALID_FEE_TYPES.has(fee_type)) {
      return new Response(JSON.stringify({
        error: `Invalid fee_type. Must be one of: ${[...VALID_FEE_TYPES].join(", ")}`,
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select("id, service_area_id, vehicle_type_id, payment_provider, provider_order_id, status")
      .eq("id", trip_id)
      .maybeSingle();

    if (tripErr || !trip) {
      return new Response(JSON.stringify({ error: "Trip not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (amount_pence <= 0 && trip.service_area_id) {
      const { data: pricingRules } = await supabase
        .from("fare_pricing_settings")
        .select(
          "cancellation_fee_pence, late_cancel_enabled, late_cancel_fee_pence, no_show_fee_pence, arrival_cancellation_enabled, arrival_cancellation_fee_pence",
        )
        .eq("service_area_id", trip.service_area_id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (pricingRules) {
        switch (fee_type) {
          case "cancellation":
            amount_pence = Number(pricingRules.cancellation_fee_pence ?? 0);
            break;
          case "late_cancel":
            amount_pence = pricingRules.late_cancel_enabled
              ? Number(pricingRules.late_cancel_fee_pence ?? 0)
              : 0;
            break;
          case "no_show":
            amount_pence = Number(pricingRules.no_show_fee_pence ?? 0);
            break;
          case "arrival_cancellation":
            amount_pence = pricingRules.arrival_cancellation_enabled
              ? Number(pricingRules.arrival_cancellation_fee_pence ?? 0)
              : 0;
            break;
          default:
            amount_pence = 0;
        }
      }
    }

    if (amount_pence <= 0 && fee_type !== "waiting_surcharge") {
      // Zero fee → full release via disposer
      const result = await disposeTerminalTripPayment(supabase, {
        tripId: trip_id,
        reason: "customer_cancel",
        feePence: 0,
        forceFeePenceOverride: true,
      });
      return new Response(JSON.stringify({
        success: true,
        charged: false,
        amount_pence: 0,
        fee_type,
        reason: "fee_is_zero",
        disposition: result.outcome,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await disposeTerminalTripPayment(supabase, {
      tripId: trip_id,
      reason: "customer_cancel",
      feePence: amount_pence,
      forceFeePenceOverride: true,
    });

    return new Response(JSON.stringify({
      success: true,
      charged: amount_pence > 0,
      amount_pence,
      fee_type,
      disposition: result.outcome,
      message: result.message ?? null,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[charge-lifecycle-fee]", message);
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
