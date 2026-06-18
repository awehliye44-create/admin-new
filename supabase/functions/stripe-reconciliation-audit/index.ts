/**
 * Phase 3C.4 — Read-only Stripe reconciliation audit (no DB writes).
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@18.5.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function isServiceRoleBearer(authHeader: string | null, serviceKey: string): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  if (token === serviceKey) return true;
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

async function stripeList<T extends { id: string }>(
  fetchPage: (startingAfter?: string) => Promise<Stripe.ApiList<T>>,
): Promise<T[]> {
  const out: T[] = [];
  let startingAfter: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await fetchPage(startingAfter);
    out.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return out;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!isServiceRoleBearer(req.headers.get("Authorization"), serviceKey)) {
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

  const sinceIso = (await req.json().catch(() => ({}))).since ?? "2026-05-01";
  const sinceTs = Math.floor(new Date(`${sinceIso}T00:00:00Z`).getTime() / 1000);

  const stripe = new Stripe(stripeSecret, {
    apiVersion: "2023-10-16",
    httpClient: Stripe.createFetchHttpClient(),
  });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

  const { data: drivers } = await supabase
    .from("drivers")
    .select("id, driver_code, first_name, last_name, stripe_account_id")
    .not("stripe_account_id", "is", null);

  const platformPayouts = await stripeList((sa) =>
    stripe.payouts.list({
      limit: 100,
      created: { gte: sinceTs },
      ...(sa ? { starting_after: sa } : {}),
    })
  );

  const platformTransfers = await stripeList((sa) =>
    stripe.transfers.list({
      limit: 100,
      created: { gte: sinceTs },
      ...(sa ? { starting_after: sa } : {}),
    })
  );

  const connectedPayouts: Array<Record<string, unknown>> = [];
  const connectedTransfers: Array<Record<string, unknown>> = [];

  for (const d of drivers ?? []) {
    const acct = d.stripe_account_id as string;
    if (!acct) continue;

    const payouts = await stripeList((sa) =>
      stripe.payouts.list(
        {
          limit: 100,
          created: { gte: sinceTs },
          ...(sa ? { starting_after: sa } : {}),
        },
        { stripeAccount: acct },
      )
    );
    for (const p of payouts) {
      connectedPayouts.push({
        driver_id: d.id,
        driver_code: d.driver_code,
        driver_name: `${d.first_name} ${d.last_name}`,
        stripe_account_id: acct,
        id: p.id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        method: p.method,
        arrival_date: p.arrival_date,
        created: p.created,
        failure_message: p.failure_message,
      });
    }

    const transfers = await stripeList((sa) =>
      stripe.transfers.list({
        limit: 100,
        created: { gte: sinceTs },
        destination: acct,
        ...(sa ? { starting_after: sa } : {}),
      })
    );
    for (const t of transfers) {
      connectedTransfers.push({
        driver_id: d.id,
        driver_code: d.driver_code,
        stripe_account_id: acct,
        id: t.id,
        amount: t.amount,
        currency: t.currency,
        created: t.created,
        destination: t.destination,
        description: t.description,
      });
    }
  }

  const balanceTransactions = await stripeList((sa) =>
    stripe.balanceTransactions.list({
      limit: 100,
      created: { gte: sinceTs },
      ...(sa ? { starting_after: sa } : {}),
    })
  );

  const payoutRelatedBalanceTx = balanceTransactions
    .filter(
      (bt) =>
        bt.type === "payout" ||
        bt.type === "transfer" ||
        bt.reporting_category === "payout" ||
        String(bt.source ?? "").startsWith("po_") ||
        String(bt.source ?? "").startsWith("tr_"),
    )
    .map((bt) => ({
      id: bt.id,
      amount: bt.amount,
      net: bt.net,
      fee: bt.fee,
      currency: bt.currency,
      type: bt.type,
      reporting_category: bt.reporting_category,
      source: bt.source,
      created: bt.created,
      description: bt.description,
    }));

  const { data: ledger } = await supabase
    .from("driver_wallet_ledger")
    .select("id, driver_id, type, amount_pence, stripe_transfer_id, stripe_payout_id, created_at")
    .in("type", ["MANUAL_PAYOUT", "WEEKLY_PAYOUT", "PAYOUT", "EARLY_CASHOUT"]);

  const { data: items } = await supabase.from("payout_items").select("*");
  const { data: batches } = await supabase.from("payout_batches").select("*");

  return new Response(
    JSON.stringify({
      since: sinceIso,
      since_ts: sinceTs,
      platform_payouts: platformPayouts.map((p) => ({
        id: p.id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        method: p.method,
        arrival_date: p.arrival_date,
        created: p.created,
      })),
      platform_transfers: platformTransfers.map((t) => ({
        id: t.id,
        amount: t.amount,
        currency: t.currency,
        created: t.created,
        destination: t.destination,
        description: t.description,
      })),
      connected_payouts: connectedPayouts,
      connected_transfers: connectedTransfers,
      balance_transactions: payoutRelatedBalanceTx,
      db_ledger_payouts: ledger,
      db_payout_items: items,
      db_payout_batches: batches,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
