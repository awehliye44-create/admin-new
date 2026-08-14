import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { loadPaymentSession, markPaymentSessionOrphaned } from "../_shared/paymentSessionSSOT.ts";
import {
  isRevolutAuthorisedState,
  isRevolutInFlightState,
} from "../_shared/revolutPaymentConfirmation.ts";
import { resolveRevolutMerchantContext } from "../_shared/revolutMerchantContext.ts";
import { retrieveRevolutOrder } from "../_shared/revolutOrders.ts";
import { serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serveWithEdgeTiming("report-payment-recovery-needed", corsHeaders, async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseAnonKey) return json({ error: "SUPABASE_ANON_KEY not set" }, 500);

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);

  const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const token = authHeader.replace("Bearer ", "");
  const { data: claimsData, error: claimsError } = await anonClient.auth.getClaims(token);
  if (claimsError || !claimsData?.claims) return json({ error: "Unauthorized" }, 401);
  const userId = claimsData.claims.sub as string;

  const body = await req.json().catch(() => ({})) as {
    client_action_id?: string;
    provider_order_id?: string;
    payment_session_id?: string;
  };

  const clientActionId = String(body.client_action_id ?? "").trim() || null;
  const providerOrderId = String(body.provider_order_id ?? "").trim() || null;
  const paymentSessionId = String(body.payment_session_id ?? "").trim() || null;
  if (!clientActionId && !providerOrderId && !paymentSessionId) {
    return json({ error: "client_action_id or provider_order_id required" }, 400);
  }

  const session = await loadPaymentSession(supabase, {
    clientActionId,
    providerOrderId,
  }) ?? (paymentSessionId
    ? (await supabase.from("payment_sessions").select("*").eq("id", paymentSessionId).maybeSingle()).data as Record<string, unknown> | null
    : null);

  if (!session) {
    return json({ success: true, escalated: false, reason: "session_not_found" });
  }
  if (String(session.user_id ?? "") !== userId) {
    return json({ error: "Payment session does not belong to this user" }, 403);
  }

  const tripId = session.trip_id ? String(session.trip_id) : null;
  if (tripId) {
    return json({ success: true, escalated: false, trip_id: tripId });
  }

  const orderId = String(session.provider_order_id ?? providerOrderId ?? "").trim() || null;
  if (!orderId) {
    return json({ success: true, escalated: false, reason: "no_provider_order" });
  }

  let providerState = "unknown";
  let declined = false;
  try {
    const merchant = await resolveRevolutMerchantContext(supabase, "live");
    const order = await retrieveRevolutOrder(merchant.environment, merchant.secretKey, orderId);
    providerState = String(order.state ?? "unknown").toUpperCase();
    declined = ["CANCELLED", "FAILED", "DECLINED"].includes(providerState);
    if (declined) {
      return json({ success: true, escalated: false, provider_state: providerState, declined: true });
    }
    if (isRevolutAuthorisedState(providerState) || isRevolutInFlightState(providerState)) {
      /* escalate below — authorised/in-flight with no trip after client poll budget */
    }
  } catch {
    /* non-fatal — still escalate for admin review */
  }

  const { data: customer } = await supabase
    .from("customers")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  await markPaymentSessionOrphaned(supabase, {
    clientActionId: String(session.client_action_id ?? clientActionId ?? ""),
    providerOrderId: orderId,
    userId,
    customerId: (customer?.id as string | undefined) ?? null,
    serviceAreaId: String(session.service_area_id ?? "") || null,
    authorisedAmountPence: Number(session.authorised_amount_pence ?? 0) || null,
    failureReason: "customer_poll_timeout_90s",
    failureStage: "client_payment_session_poll",
    bookingSnapshot: (session.booking_snapshot as Record<string, unknown> | undefined) ?? undefined,
  });

  return json({
    success: true,
    escalated: true,
    provider_order_id: orderId,
    provider_state: providerState,
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
