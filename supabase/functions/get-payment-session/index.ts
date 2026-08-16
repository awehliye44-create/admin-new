import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { loadPaymentSession } from "../_shared/paymentSessionSSOT.ts";
import { serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serveWithEdgeTiming("get-payment-session", corsHeaders, async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseAnonKey) {
    return json({ error: "SUPABASE_ANON_KEY not set" }, 500);
  }

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
    payment_intent_id?: string;
    payment_session_id?: string;
  };

  const clientActionId = String(body.client_action_id ?? "").trim() || null;
  const providerOrderId = String(
    body.provider_order_id ?? body.payment_intent_id ?? "",
  ).trim() || null;
  const paymentSessionId = String(body.payment_session_id ?? "").trim() || null;

  if (!clientActionId && !providerOrderId && !paymentSessionId) {
    return json({ error: "client_action_id or provider_order_id required" }, 400);
  }

  let session: Record<string, unknown> | null = null;
  if (paymentSessionId) {
    const { data } = await supabase
      .from("payment_sessions")
      .select("*")
      .eq("id", paymentSessionId)
      .maybeSingle();
    session = (data as Record<string, unknown> | null) ?? null;
  } else {
    session = await loadPaymentSession(supabase, {
      clientActionId,
      providerOrderId,
    });
  }

  if (!session) {
    return json({ success: true, found: false, session: null });
  }

  if (String(session.user_id ?? "") !== userId) {
    return json({ error: "Payment session does not belong to this user" }, 403);
  }

  const tripId = session.trip_id ? String(session.trip_id) : null;
  let tripReference: string | null = null;
  let orphanPayment: Record<string, unknown> | null = null;
  if (tripId) {
    const { data: trip } = await supabase
      .from("trips")
      .select("trip_code")
      .eq("id", tripId)
      .maybeSingle();
    tripReference = (trip?.trip_code as string | null) ?? null;
  }

  const sessionProviderOrderId = session.provider_order_id
    ? String(session.provider_order_id)
    : null;
  if (sessionProviderOrderId) {
    const { data: orphan } = await supabase
      .from("orphan_payments")
      .select("id, amount_pence, payment_status, reversal_status, failure_reason, metadata")
      .eq("provider_order_id", sessionProviderOrderId)
      .maybeSingle();
    orphanPayment = (orphan as Record<string, unknown> | null) ?? null;
  }

  return json({
    success: true,
    found: true,
    session: {
      payment_session_id: session.id,
      client_action_id: session.client_action_id,
      provider_order_id: session.provider_order_id,
      status: session.status,
      trip_id: tripId,
      trip_reference: tripReference,
      failure_reason: session.failure_reason ?? null,
      authorised_amount_pence: session.authorised_amount_pence ?? null,
      updated_at: session.updated_at ?? null,
      orphan_payment: orphanPayment,
    },
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
