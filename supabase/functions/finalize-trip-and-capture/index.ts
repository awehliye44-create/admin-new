/**
 * finalize-trip-and-capture — existing Revolut completion path only.
 *
 * P0 #1: every invocation must leave a durable settlement outcome on the trip.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { finalizeRevolutTripCapture } from "../_shared/finalizeRevolutTripCapture.ts";
import { tripProviderOrderId } from "../_shared/tripPaymentProviderSSOT.ts";
import {
  durableSettlementColumns,
  needsDurableSettlementPersist,
} from "../../../shared/durableSettlementOutcomeSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function persistDurableOutcome(
  supabase: ReturnType<typeof createClient>,
  tripId: string,
  status: string,
  success: boolean,
): Promise<void> {
  const cols = durableSettlementColumns(status, success);
  await supabase.from("trips").update({
    payment_status: cols.payment_status,
    payment_hold_status: cols.payment_hold_status,
    updated_at: new Date().toISOString(),
  }).eq("id", tripId);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let tripIdForCatch: string | null = null;

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
    tripIdForCatch = String(trip_id);

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

    if (
      String(trip.financial_model ?? "").toUpperCase()
      === "DRIVER_COLLECTED_COMMISSION_WALLET"
    ) {
      return new Response(JSON.stringify({
        success: false,
        error: "FINANCIAL_MODEL_VIOLATION: platform capture forbidden on DRIVER_COLLECTED_COMMISSION_WALLET",
        error_code: "FINANCIAL_MODEL_VIOLATION",
        status: "financial_model_violation",
      }), {
        status: 409,
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
      await persistDurableOutcome(
        supabaseClient,
        trip_id,
        "provider_authorisation_missing",
        false,
      );
      return new Response(JSON.stringify({
        success: false,
        error: "Trip has no Revolut provider order for capture",
        status: "provider_authorisation_missing",
      }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let revolutResult;
    try {
      revolutResult = await finalizeRevolutTripCapture({
        supabase: supabaseClient,
        trip,
        tipPence,
      });
    } catch (captureErr) {
      const message = captureErr instanceof Error ? captureErr.message : String(captureErr);
      await persistDurableOutcome(supabaseClient, trip_id, "capture_failed", false);
      return new Response(JSON.stringify({
        success: false,
        error: message,
        status: "capture_failed",
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cols = durableSettlementColumns(
      String(revolutResult.status ?? ""),
      Boolean(revolutResult.success),
    );
    const { data: fresh } = await supabaseClient
      .from("trips")
      .select("payment_status, payment_hold_status, payment_state")
      .eq("id", trip_id)
      .maybeSingle();

    if (
      needsDurableSettlementPersist({
        paymentStatus: fresh?.payment_status,
        paymentHoldStatus: fresh?.payment_hold_status,
        paymentState: fresh?.payment_state,
        finalizeSuccess: Boolean(revolutResult.success),
        finalizeStatus: String(revolutResult.status ?? ""),
      })
    ) {
      await supabaseClient.from("trips").update({
        payment_status: cols.payment_status,
        payment_hold_status: cols.payment_hold_status,
        updated_at: new Date().toISOString(),
      }).eq("id", trip_id);
    }

    return new Response(JSON.stringify(revolutResult), {
      status: revolutResult.success ? 200 : 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[finalize-trip-and-capture]", message);
    if (tripIdForCatch) {
      try {
        const supabaseClient = createClient(
          Deno.env.get("SUPABASE_URL") ?? "",
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
          { auth: { persistSession: false } },
        );
        await persistDurableOutcome(supabaseClient, tripIdForCatch, "capture_failed", false);
      } catch {
        // best-effort
      }
    }
    return new Response(JSON.stringify({
      success: false,
      error: message,
      status: "capture_failed",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
