/**
 * update-preauth-on-trip-modification
 *
 * Raise payment authorisation when a trip modification increases payable fare.
 * Revolut path: same-order incremental authorisation first (never a second order by default).
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { prepareRevolutModificationAuthorisation } from "../_shared/revolutModTopUp.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No authorization header provided" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const tripId = body.trip_id ?? body.tripId;
    const newEstimatedTotalPence = Number(
      body.new_estimated_total_pence ?? body.newEstimatedTotalPence ?? 0,
    );
    if (!tripId) {
      return new Response(JSON.stringify({ error: "trip_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!Number.isFinite(newEstimatedTotalPence) || newEstimatedTotalPence <= 0) {
      return new Response(JSON.stringify({
        success: false,
        skipped: true,
        error: "Invalid payable total for preauth update",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select(
        "id, passenger_id, payment_provider, payment_method, provider_order_id, "
          + "authorised_amount_pence, currency_code, "
          + "estimated_total_pence, final_customer_fare_pence, client_action_id",
      )
      .eq("id", tripId)
      .maybeSingle();

    if (tripErr || !trip) {
      return new Response(JSON.stringify({ error: "Trip not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const isCash = String(trip.payment_method ?? "").toLowerCase().includes("cash");
    if (isCash) {
      return new Response(JSON.stringify({
        success: true,
        skipped: true,
        payment_coverage_status: "not_required",
        authorised_amount_pence: newEstimatedTotalPence,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const isRevolut = String(trip.payment_provider ?? "").toLowerCase() === "revolut"
      || Boolean(trip.provider_order_id);

    if (!isRevolut) {
      return new Response(JSON.stringify({
        success: false,
        error: "Non-Revolut incremental authorisation is not available on this path",
        payment_coverage_status: "authorization_insufficient",
      }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await prepareRevolutModificationAuthorisation({
      supabase,
      trip: trip as Record<string, unknown>,
      targetAuthorisedAmountPence: newEstimatedTotalPence,
      updatedEstimatedTotalPence: newEstimatedTotalPence,
      allowControlledFallback: false,
    });

    if (!result.ok) {
      return new Response(JSON.stringify({
        success: false,
        error: result.error,
        warning: result.error,
        payment_coverage_status: result.payment_coverage_status ?? "authorization_insufficient",
        error_code: result.error_code,
      }), {
        status: result.status ?? 402,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (result.sufficient) {
      return new Response(JSON.stringify({
        success: true,
        skipped: false,
        authorised_amount_pence: result.authorised_amount_pence,
        total_authorized_amount_pence: result.authorised_amount_pence,
        amount_capturable: result.authorised_amount_pence,
        payment_coverage_status: result.payment_coverage_status,
        increment_used: result.increment_used === true,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Controlled fallback checkout (only if allowControlledFallback was true).
    return new Response(JSON.stringify({
      success: false,
      warning: "Additional payment confirmation required",
      payment_coverage_status: "authorization_insufficient",
      requires_revolut_checkout: true,
      provider_order_id: result.provider_order_id,
      provider_checkout_token: result.provider_checkout_token,
      authorised_amount_pence: result.authorised_amount_pence,
      top_up_amount_pence: result.top_up_amount_pence,
      error_code: result.error_code,
    }), {
      status: 402,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[update-preauth-on-trip-modification]", error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      payment_coverage_status: "authorization_insufficient",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
