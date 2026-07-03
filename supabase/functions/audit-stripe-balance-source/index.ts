// Read-only Stripe raw audit for MK0001 & MK0002.
// Prints raw balance.retrieve, payouts.list, balanceTransactions.list, transfers.list.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ACCOUNTS = [
  { code: "MK0001", stripeAccount: "acct_1ThTrEEXTz9Ab5Ic" },
  { code: "MK0002", stripeAccount: "acct_1ThUR8Izd0dzmC0Y" },
];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const secret = Deno.env.get("STRIPE_SECRET_KEY");
  if (!secret) return new Response(JSON.stringify({ error: "STRIPE_SECRET_KEY missing" }), { status: 500, headers: corsHeaders });

  const stripe = new Stripe(secret, { apiVersion: "2023-10-16", httpClient: Stripe.createFetchHttpClient() });

  const result: Record<string, unknown> = {};
  for (const acc of ACCOUNTS) {
    const opts = { stripeAccount: acc.stripeAccount };
    const [balance, payouts, txns, transfers, accountInfo] = await Promise.all([
      stripe.balance.retrieve(undefined, opts),
      stripe.payouts.list({ limit: 10 }, opts),
      stripe.balanceTransactions.list({ limit: 10 }, opts),
      stripe.transfers.list({ limit: 10, destination: acc.stripeAccount }),
      stripe.accounts.retrieve(acc.stripeAccount),
    ]);
    result[acc.code] = {
      connected_account_id: acc.stripeAccount,
      account: {
        payouts_enabled: accountInfo.payouts_enabled,
        charges_enabled: accountInfo.charges_enabled,
        payout_schedule: accountInfo.settings?.payouts?.schedule ?? null,
      },
      "balance.retrieve": {
        available: balance.available,
        pending: balance.pending,
        instant_available: (balance as any).instant_available ?? null,
        connect_reserved: (balance as any).connect_reserved ?? null,
      },
      "payouts.list (connected)": payouts.data.map((p) => ({
        id: p.id, amount: p.amount, currency: p.currency, status: p.status,
        automatic: p.automatic, arrival_date: p.arrival_date, created: p.created,
      })),
      "balanceTransactions.list (connected)": txns.data.map((t) => ({
        id: t.id, type: t.type, amount: t.amount, net: t.net, currency: t.currency,
        status: t.status, created: t.created, source: t.source,
      })),
      "transfers.list (platform→destination)": transfers.data.map((t) => ({
        id: t.id, amount: t.amount, currency: t.currency, destination: t.destination,
        created: t.created,
      })),
    };
  }

  return new Response(JSON.stringify(result, null, 2), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
