/**
 * finalize-trip-and-capture — Revolut same-order increment then capture path.
 *
 * Production historically also contained Stripe capture; Stripe mutations remain
 * retired. This source restores the Revolut completion entrypoint used by the
 * driver/admin completion flow so Phase B can deploy the increment-aware path.
 *
 * Do not deploy without explicit approval.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { finalizeRevolutTripCapture } from "../_shared/finalizeRevolutTripCapture.ts";
import { looksLikeStripePaymentIntentId } from "../_shared/stripeRetirementGuard.ts";

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

    const isRevolutTrip = String(trip.payment_provider ?? "").toLowerCase() === "revolut"
      || (
        !looksLikeStripePaymentIntentId(trip.stripe_payment_intent_id)
        && Boolean(trip.provider_order_id || trip.stripe_payment_intent_id)
      );

    if (!isRevolutTrip) {
      return new Response(JSON.stringify({
        success: false,
        error: "Non-Revolut capture is not available on this finalize path",
        status: "provider_unsupported",
      }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("[FINALIZE-CAPTURE] Revolut trip — same-order increment then capture", {
      trip_id,
    });

    const revolutResult = await finalizeRevolutTripCapture({
      supabase: supabaseClient,
      trip: trip as Record<string, unknown>,
      tipPence,
    });

    if (!revolutResult.success) {
      await supabaseClient.from("trips").update({
        payment_status: "capture_failed",
        updated_at: new Date().toISOString(),
      }).eq("id", trip_id);
    }

    return new Response(JSON.stringify(revolutResult), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: revolutResult.success ? 200 : 400,
    });
  } catch (error) {
    console.error("[FINALIZE-CAPTURE]", error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
