import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function isServiceRoleBearer(authHeader: string | null): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  try {
    const token = authHeader.slice(7);
    const payloadB64 = token.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/");
    if (!payloadB64) return false;
    const payload = JSON.parse(atob(payloadB64));
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (!isServiceRoleBearer(req.headers.get("Authorization"))) {
    return new Response(JSON.stringify({ error: "service role required" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const stripeSecret = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeSecret) {
    return new Response(JSON.stringify({ error: "STRIPE_SECRET_KEY missing" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: { payout_id?: string; stripe_account_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const payoutId = body.payout_id;
  const accountId = body.stripe_account_id;
  if (!payoutId || !accountId) {
    return new Response(JSON.stringify({ error: "payout_id and stripe_account_id required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const stripe = new Stripe(stripeSecret, {
    apiVersion: "2023-10-16",
    httpClient: Stripe.createFetchHttpClient(),
  });

  const payout = await stripe.payouts.retrieve(payoutId, { stripeAccount: accountId });

  return new Response(JSON.stringify({
    id: payout.id,
    status: payout.status,
    method: payout.method,
    amount: payout.amount,
    currency: payout.currency,
    arrival_date: payout.arrival_date,
    created: payout.created,
    failure_message: payout.failure_message ?? null,
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
