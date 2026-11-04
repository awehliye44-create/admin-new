/**
 * One-shot: re-run customer refund confirmations for MK-261104-003 after
 * contact-lookup fix (customers has no email column → prior skips were wrong).
 * Does not issue another Revolut refund. Auth: service role / internal finalize.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { notifyCustomerConfirmedRefund } from "../_shared/customerRefundNotify.ts";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";

const TRIP_ID = "07d3d9cf-1e50-4935-aaab-35aea4b5422c";
const TRIP_CODE = "MK-261104-003";
const PROVIDER_REFUND_ID = "6aebb69c-ac24-a1b2-9415-6447fc31be2e";
const AMOUNT_PENCE = 500;
const CONFIRM = "MK-261104-003-RETRY-REFUND-NOTIFY";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-onecab-internal-finalize",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const internal = req.headers.get("x-onecab-internal-finalize") ?? "";
    const configuredInternal = Deno.env.get("ONECAB_INTERNAL_FINALIZE_SECRET") ?? "";
    const okAuth =
      (configuredInternal.length >= 20 && internal === configuredInternal) ||
      (await assertCronOrServiceRoleAuth(req)).ok;
    if (!okAuth) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    if (body?.confirm !== CONFIRM) {
      return new Response(
        JSON.stringify({ error: "confirm token required", expected: CONFIRM }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select("id, trip_code, payment_session_id, refund_amount_pence")
      .eq("id", TRIP_ID)
      .single();
    if (tripErr || !trip) throw new Error(`Trip not found: ${tripErr?.message}`);
    if (trip.trip_code !== TRIP_CODE) throw new Error("trip_code mismatch");
    if (Number(trip.refund_amount_pence ?? 0) < AMOUNT_PENCE) {
      throw new Error("expected £5 refund already recorded on trip");
    }

    // Prior skips were caused by selecting non-existent customers.email.
    // Mark them failed so claimChannel can retry only those channels.
    const { error: resetErr } = await supabase
      .from("customer_refund_notification_deliveries")
      .update({
        status: "failed",
        skipped_reason: null,
        error_message: "retry_after_contact_lookup_fix",
        updated_at: new Date().toISOString(),
      })
      .eq("provider_refund_id", PROVIDER_REFUND_ID)
      .eq("status", "skipped")
      .in("skipped_reason", ["missing_user_id", "missing_email", "missing_phone"]);
    if (resetErr) throw new Error(`reset failed: ${resetErr.message}`);

    const channels = await notifyCustomerConfirmedRefund(supabase, {
      tripId: TRIP_ID,
      providerRefundId: PROVIDER_REFUND_ID,
      amountPence: AMOUNT_PENCE,
      paymentSessionId: trip.payment_session_id ?? null,
      refundStatus: "confirmed",
      source: "admin_remediate_mk261104003_notify_retry",
    });

    const { data: deliveries } = await supabase
      .from("customer_refund_notification_deliveries")
      .select(
        "channel, status, skipped_reason, error_message, provider_message_id, updated_at",
      )
      .eq("provider_refund_id", PROVIDER_REFUND_ID)
      .order("channel");

    return new Response(
      JSON.stringify({
        success: true,
        trip_code: TRIP_CODE,
        provider_refund_id: PROVIDER_REFUND_ID,
        channels,
        deliveries,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    console.error("[admin-remediate-mk261104003-refund-notify]", e);
    return new Response(
      JSON.stringify({ error: (e as Error).message ?? String(e) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
