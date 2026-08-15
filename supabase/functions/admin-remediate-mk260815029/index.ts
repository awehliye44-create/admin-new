/**
 * One-shot remediation: MK-260815-029 modification double-count overcapture.
 * - Revolut refund 266p
 * - PS/trip refund records (preserve gross captured 982)
 * - Skip proportional REFUND_DEBIT
 * - SETTLEMENT_CORRECTION −184p → effective driver net 651
 *
 * Auth: service role Bearer OR x-onecab-internal-finalize secret.
 * Body must include confirm: "MK-260815-029-REFUND-266-WALLET-184"
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  refundRevolutOrder,
  retrieveRevolutOrder,
  getRevolutMerchantConfig,
} from "../_shared/revolutOrders.ts";
import { applyProviderRefundToOnecab } from "../_shared/applyProviderRefund.ts";

const TRIP_ID = "9384ecfc-c450-4290-9385-75195db32fde";
const TRIP_CODE = "MK-260815-029";
const DRIVER_ID = "cd8bae4c-3827-4b90-98c6-10be70eb0e52";
const REFUND_PENCE = 266;
const WALLET_CORRECTION_PENCE = -184;
const CONFIRM = "MK-260815-029-REFUND-266-WALLET-184";
const CORRECTION_TYPE = "ADJUSTMENT";

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

    const auth = req.headers.get("Authorization") ?? "";
    const bearer = auth.replace(/^Bearer\s+/i, "").trim();
    const internal = req.headers.get("x-onecab-internal-finalize") ?? "";
    const configuredInternal = Deno.env.get("ONECAB_INTERNAL_FINALIZE_SECRET") ?? "";
    let okAuth =
      (bearer && bearer === serviceKey) ||
      (configuredInternal && internal === configuredInternal);
    // Accept any valid service_role JWT (project may rotate literal env vs gateway key).
    if (!okAuth && bearer.split(".").length === 3) {
      try {
        const payload = JSON.parse(atob(bearer.split(".")[1]!));
        if (payload?.role === "service_role") okAuth = true;
      } catch { /* ignore */ }
    }
    if (!okAuth) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    if (body?.confirm !== CONFIRM) {
      return new Response(JSON.stringify({
        error: "confirm token required",
        expected: CONFIRM,
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select(
        "id, trip_code, driver_id, provider_order_id, capture_amount_pence, refund_amount_pence, final_fare_pence, final_customer_fare_pence, driver_net_pence",
      )
      .eq("id", TRIP_ID)
      .single();
    if (tripErr || !trip) throw new Error(`Trip not found: ${tripErr?.message}`);
    if (trip.trip_code !== TRIP_CODE) throw new Error("trip_code mismatch");
    if (String(trip.driver_id) !== DRIVER_ID) throw new Error("driver mismatch");

    const orderId = String(trip.provider_order_id ?? "");
    if (!orderId) throw new Error("missing provider_order_id");

    const alreadyRefunded = Math.max(0, Number(trip.refund_amount_pence ?? 0));
    let refundResult: Record<string, unknown> | null = null;

    if (alreadyRefunded >= REFUND_PENCE) {
      refundResult = {
        skipped: true,
        reason: "already_refunded",
        already_refunded_pence: alreadyRefunded,
      };
    } else {
      const { secretKey, environment } = getRevolutMerchantConfig();
      const orderBefore = await retrieveRevolutOrder(environment, secretKey, orderId);
      const state = String(orderBefore.state ?? "").toUpperCase();
      if (state !== "COMPLETED" && state !== "REFUNDED") {
        throw new Error(`Cannot refund — Revolut state ${state}`);
      }

      const refund = await refundRevolutOrder(
        environment,
        secretKey,
        orderId,
        REFUND_PENCE,
        "MK-260815-029 modification double-count overcapture remediation (982→716)",
      );

      const onecab = await applyProviderRefundToOnecab(supabase, {
        tripId: TRIP_ID,
        amountRefundedPence: alreadyRefunded + REFUND_PENCE,
        provider: "revolut",
        providerRefundId: refund.id ?? null,
        providerOrderId: orderId,
        source: "admin_refund",
        refundReason:
          "MK-260815-029 destination-change double-count: refund excess 266p (canonical payable 716)",
        skipDriverWalletReversal: true,
      });

      refundResult = {
        skipped: false,
        revolut_refund_id: refund.id ?? null,
        refunded_pence: REFUND_PENCE,
        onecab,
      };
    }

    // Correct poisoned trip.final_fare_pence for future FR expected (gross capture stays on PS).
    await supabase
      .from("trips")
      .update({
        final_fare_pence: 716,
        updated_at: new Date().toISOString(),
      })
      .eq("id", TRIP_ID);

    const { data: existingCorr } = await supabase
      .from("driver_wallet_ledger")
      .select("id, amount_pence, description")
      .eq("related_trip_id", TRIP_ID)
      .eq("type", CORRECTION_TYPE)
      .ilike("description", "%MK-260815-029%")
      .maybeSingle();

    let walletCorrection: Record<string, unknown>;
    if (existingCorr) {
      walletCorrection = { skipped: true, existing: existingCorr };
    } else {
      const { data: inserted, error: ledErr } = await supabase
        .from("driver_wallet_ledger")
        .insert({
          driver_id: DRIVER_ID,
          related_trip_id: TRIP_ID,
          type: CORRECTION_TYPE,
          amount_pence: WALLET_CORRECTION_PENCE,
          currency: "GBP",
          description:
            "MK-260815-029 modification double-count / canonical settlement correction (−184p; TRIP_EARNING_NET 835→effective 651)",
        })
        .select("id, type, amount_pence, description, created_at")
        .single();
      if (ledErr) throw new Error(`wallet correction failed: ${ledErr.message}`);
      walletCorrection = { skipped: false, entry: inserted };
    }

    const { data: ledger } = await supabase
      .from("driver_wallet_ledger")
      .select("type, amount_pence, description")
      .eq("related_trip_id", TRIP_ID)
      .order("created_at");

    const effectiveNet = (ledger ?? []).reduce(
      (sum, row) => sum + Number(row.amount_pence ?? 0),
      0,
    );

    const { data: session } = await supabase
      .from("payment_sessions")
      .select(
        "id, authorised_amount_pence, total_authorised_amount_pence, captured_amount_pence, refunded_amount_pence, financial_operation_state, provider_state",
      )
      .eq("trip_id", TRIP_ID)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Confirm 028 untouched
    const { data: trip028 } = await supabase
      .from("trips")
      .select("trip_code, capture_amount_pence, refund_amount_pence, final_fare_pence")
      .eq("trip_code", "MK-260815-028")
      .maybeSingle();

    return new Response(
      JSON.stringify({
        success: true,
        trip_id: TRIP_ID,
        trip_code: TRIP_CODE,
        refund: refundResult,
        wallet_correction: walletCorrection,
        effective_trip_wallet_pence: effectiveNet,
        expected_effective_net: 651,
        payment_session: session,
        trip_028_untouched: trip028,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[admin-remediate-mk260815029]", e);
    const message = e instanceof Error
      ? e.message
      : typeof e === "string"
      ? e
      : JSON.stringify(e);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
