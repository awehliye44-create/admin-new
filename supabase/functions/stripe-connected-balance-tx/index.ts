/**
 * One-shot: connected-account balance transactions (read-only).
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  let ok = token === serviceKey;
  if (!ok && token) {
    try {
      const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      ok = payload.role === "service_role";
    } catch { /* ignore */ }
  }
  if (!ok) {
    return new Response(JSON.stringify({ error: "service role required" }), { status: 401 });
  }
  const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
    apiVersion: "2023-10-16",
    httpClient: Stripe.createFetchHttpClient(),
  });
  const { stripe_account_id, since = "2026-05-01" } = await req.json();
  const sinceTs = Math.floor(new Date(`${since}T00:00:00Z`).getTime() / 1000);
  const out: unknown[] = [];
  let sa: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = await stripe.balanceTransactions.list(
      { limit: 100, created: { gte: sinceTs }, ...(sa ? { starting_after: sa } : {}) },
      { stripeAccount: stripe_account_id },
    );
    out.push(...page.data.map((bt) => ({
      id: bt.id,
      amount: bt.amount,
      net: bt.net,
      fee: bt.fee,
      type: bt.type,
      source: bt.source,
      created: bt.created,
      description: bt.description,
    })));
    if (!page.has_more) break;
    sa = page.data[page.data.length - 1]?.id;
  }
  return new Response(JSON.stringify({ stripe_account_id, transactions: out }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
