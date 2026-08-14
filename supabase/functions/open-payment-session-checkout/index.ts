import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  isAuthorisedHoldSessionStatus,
  loadPaymentSession,
  markPaymentSessionCheckoutOpen,
} from "../_shared/paymentSessionSSOT.ts";
import { serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TERMINAL_SESSION = new Set([
  "authorised_hold",
  "payment_authorised",
  "trip_created",
  "dispatching",
  "completed_pending_capture",
  "captured",
  "released",
  "cancelled",
]);

serveWithEdgeTiming("open-payment-session-checkout", corsHeaders, async (req) => {
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
  };

  const clientActionId = String(body.client_action_id ?? "").trim() || null;
  const providerOrderId = String(body.provider_order_id ?? "").trim() || null;

  if (!clientActionId && !providerOrderId) {
    return json({ error: "client_action_id or provider_order_id required" }, 400);
  }

  const session = await loadPaymentSession(supabase, {
    clientActionId,
    providerOrderId,
  });

  if (!session) {
    console.info("CHECKOUT_OPENED", { client_action_id: clientActionId, provider_order_id: providerOrderId, found: false });
    return json({ success: true, skipped: true, reason: "session_not_found" });
  }

  if (String(session.user_id ?? "") !== userId) {
    return json({ error: "Payment session does not belong to this user" }, 403);
  }

  const status = String(session.status ?? "");
  if (TERMINAL_SESSION.has(status) || isAuthorisedHoldSessionStatus(status)) {
    return json({ success: true, skipped: true, reason: "session_already_terminal", status });
  }

  await markPaymentSessionCheckoutOpen(supabase, {
    clientActionId: clientActionId ?? String(session.client_action_id ?? ""),
    providerOrderId: providerOrderId ?? (session.provider_order_id ? String(session.provider_order_id) : null),
  });

  console.info("CHECKOUT_OPENED", {
    client_action_id: clientActionId ?? session.client_action_id,
    provider_order_id: providerOrderId ?? session.provider_order_id,
    previous_status: status,
  });

  return json({ success: true, checkout_open: true });
});

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
