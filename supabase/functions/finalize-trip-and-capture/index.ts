/**
 * finalize-trip-and-capture — existing Revolut completion path only.
 *
 * EXISTING CODE REUSED: finalizeRevolutTripCapture / revolutCompletionCapture
 * EXISTING CODE REPAIRED: removed Stripe PaymentIntent branches and Stripe PI gates
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { finalizeRevolutTripCapture } from "../_shared/finalizeRevolutTripCapture.ts";
import { tripProviderOrderId } from "../_shared/tripPaymentProviderSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    const body = await req.json().catch(() => ({}));
    const trip_id = body.trip_id ?? body.tripId;
    const tipPence = Math.max(0, Math.round(Number(body.tip_pence ?? body.tipPence ?? 0)));
    if (!trip_id) {
      return new Response(JSON.stringify({ success: false, error: "trip_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: trip, error: tripErr } = await supabaseClient
      .from("trips")
      .select("*")
      .eq("id", trip_id)
      .maybeSingle();

    if (tripErr || !trip) {
      return new Response(JSON.stringify({ success: false, error: "Trip not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (String(trip.status ?? "").toLowerCase() !== "completed") {
      return new Response(JSON.stringify({
        success: false,
        error: "Trip must be completed before capture",
        status: "trip_not_completed",
      }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const provider = String(trip.payment_provider ?? "").toLowerCase();
    const orderId = tripProviderOrderId(trip);
    if (provider !== "revolut" && !orderId) {
      return new Response(JSON.stringify({
        success: false,
        error: "Trip has no Revolut provider order for capture",
        status: "provider_unsupported",
      }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const revolutResult = await finalizeRevolutTripCapture({
      supabase: supabaseClient,
      trip,
      tipPence,
    });

    return new Response(JSON.stringify(revolutResult), {
      status: revolutResult.success ? 200 : 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[finalize-trip-and-capture]", message);
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
