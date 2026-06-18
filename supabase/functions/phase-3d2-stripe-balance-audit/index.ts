/**
 * Phase 3D.2 — Read-only Stripe balance & future payout audit (no writes).
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@18.5.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MK_REGION = "7f611e59-a9e5-42c2-b65a-61376910bb5d";
const MK0001 = "5ed232c3-8bb5-4085-95d6-73e48e6c5e28";
const MK0002 = "cd8bae4c-3827-4b90-98c6-10be70eb0e52";

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

function gbpSummary(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
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

  const stripe = new Stripe(stripeSecret, {
    apiVersion: "2023-10-16",
    httpClient: Stripe.createFetchHttpClient(),
  });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

  const platformBalance = await stripe.balance.retrieve();
  const gbpAvail = platformBalance.available.find((b) => b.currency === "gbp")?.amount ?? 0;
  const gbpPending = platformBalance.pending.find((b) => b.currency === "gbp")?.amount ?? 0;

  const platformFuturePayouts = await stripeList((sa) =>
    stripe.payouts.list({
      limit: 100,
      status: "pending",
      ...(sa ? { starting_after: sa } : {}),
    })
  );
  const platformInTransitPayouts = await stripeList((sa) =>
    stripe.payouts.list({
      limit: 100,
      status: "in_transit",
      ...(sa ? { starting_after: sa } : {}),
    })
  );

  const { data: mkDrivers } = await supabase
    .from("drivers")
    .select("id, driver_code, first_name, last_name, stripe_account_id, payouts_enabled, region_id")
    .eq("region_id", MK_REGION)
    .not("stripe_account_id", "is", null);

  const { data: ledgerPayoutIds } = await supabase
    .from("driver_wallet_ledger")
    .select("stripe_payout_id, stripe_transfer_id, driver_id, type, amount_pence")
    .not("stripe_payout_id", "is", null);

  const { data: payoutItems } = await supabase
    .from("payout_items")
    .select("id, driver_id, stripe_payout_id, stripe_transfer_id, status, amount_pence")
    .not("stripe_payout_id", "is", null);

  const ledgerPayoutSet = new Set((ledgerPayoutIds ?? []).map((r) => r.stripe_payout_id).filter(Boolean));
  const itemPayoutSet = new Set((payoutItems ?? []).map((r) => r.stripe_payout_id).filter(Boolean));

  const connectedAccounts: Array<Record<string, unknown>> = [];
  const allFuturePayouts: Array<Record<string, unknown>> = [];

  for (const d of mkDrivers ?? []) {
    const acct = d.stripe_account_id as string;
    let accountMeta: Record<string, unknown> = {};
    let connectBalance = { available_pence: 0, pending_pence: 0 };
    try {
      const account = await stripe.accounts.retrieve(acct);
      const payoutSchedule = account.settings?.payouts?.schedule;
      const payoutsEnabled = account.payouts_enabled;
      const autoPayouts = payoutSchedule?.interval !== "manual";
      accountMeta = {
        payouts_enabled: payoutsEnabled,
        payout_schedule_interval: payoutSchedule?.interval ?? null,
        payout_schedule_delay_days: payoutSchedule?.delay_days ?? null,
        automatic_payouts_enabled: autoPayouts,
        charges_enabled: account.charges_enabled,
        details_submitted: account.details_submitted,
      };

      const bal = await stripe.balance.retrieve({ stripeAccount: acct });
      connectBalance = {
        available_pence: bal.available.find((b) => b.currency === "gbp")?.amount ?? 0,
        pending_pence: bal.pending.find((b) => b.currency === "gbp")?.amount ?? 0,
      };
    } catch (e) {
      accountMeta = { error: (e as Error).message };
    }

    const pendingPayouts = await stripeList((sa) =>
      stripe.payouts.list(
        { limit: 100, status: "pending", ...(sa ? { starting_after: sa } : {}) },
        { stripeAccount: acct },
      )
    );
    const inTransitPayouts = await stripeList((sa) =>
      stripe.payouts.list(
        { limit: 100, status: "in_transit", ...(sa ? { starting_after: sa } : {}) },
        { stripeAccount: acct },
      )
    );

    for (const p of [...pendingPayouts, ...inTransitPayouts]) {
      const orphanRisk = !ledgerPayoutSet.has(p.id) && !itemPayoutSet.has(p.id);
      const row = {
        payout_id: p.id,
        owner: d.driver_code ?? d.id,
        owner_type: "connected_account",
        driver_id: d.id,
        driver_name: `${d.first_name ?? ""} ${d.last_name ?? ""}`.trim(),
        stripe_account_id: acct,
        amount_pence: p.amount,
        amount_gbp: gbpSummary(p.amount),
        currency: p.currency,
        status: p.status,
        method: p.method,
        arrival_date: p.arrival_date,
        created: p.created,
        automatic: p.automatic,
        in_ledger: ledgerPayoutSet.has(p.id),
        in_payout_items: itemPayoutSet.has(p.id),
        orphan_payout_risk: orphanRisk,
      };
      allFuturePayouts.push(row);
    }

    connectedAccounts.push({
      driver_id: d.id,
      driver_code: d.driver_code,
      driver_name: `${d.first_name ?? ""} ${d.last_name ?? ""}`.trim(),
      stripe_account_id: acct,
      db_payouts_enabled: d.payouts_enabled,
      ...accountMeta,
      balance: connectBalance,
      future_payout_count: pendingPayouts.length + inTransitPayouts.length,
      future_payout_total_pence: [...pendingPayouts, ...inTransitPayouts].reduce((s, p) => s + p.amount, 0),
    });
  }

  for (const p of [...platformFuturePayouts, ...platformInTransitPayouts]) {
    const orphanRisk = !ledgerPayoutSet.has(p.id) && !itemPayoutSet.has(p.id);
    allFuturePayouts.push({
      payout_id: p.id,
      owner: "platform",
      owner_type: "platform_account",
      driver_id: null,
      stripe_account_id: null,
      amount_pence: p.amount,
      amount_gbp: gbpSummary(p.amount),
      currency: p.currency,
      status: p.status,
      method: p.method,
      arrival_date: p.arrival_date,
      created: p.created,
      automatic: p.automatic,
      in_ledger: ledgerPayoutSet.has(p.id),
      in_payout_items: itemPayoutSet.has(p.id),
      orphan_payout_risk: orphanRisk,
    });
  }

  const connectAvailableSum = connectedAccounts.reduce(
    (s, a) => s + Number((a.balance as { available_pence?: number })?.available_pence ?? 0),
    0,
  );
  const connectPendingSum = connectedAccounts.reduce(
    (s, a) => s + Number((a.balance as { pending_pence?: number })?.pending_pence ?? 0),
    0,
  );
  const futurePayoutsSum = allFuturePayouts.reduce((s, p) => s + Number(p.amount_pence ?? 0), 0);

  return new Response(JSON.stringify({
    audit_version: "phase_3d2_stripe_balance",
    timestamp: new Date().toISOString(),
    admin_provider_available_formula: {
      field: "provider_available_balance_pence",
      formula: "stripe.balance.retrieve().available[currency=gbp].amount (platform account ONLY)",
      excludes: ["connect account available", "connect pending", "future payouts"],
    },
    platform_account: {
      available_pence: gbpAvail,
      available_gbp: gbpSummary(gbpAvail),
      pending_pence: gbpPending,
      pending_gbp: gbpSummary(gbpPending),
      incoming_earnings_note: "Stripe Dashboard 'Incoming earnings' maps to balance.pending",
    },
    connect_accounts_mk: connectedAccounts,
    connect_totals_mk: {
      available_pence: connectAvailableSum,
      available_gbp: gbpSummary(connectAvailableSum),
      pending_pence: connectPendingSum,
      pending_gbp: gbpSummary(connectPendingSum),
    },
    stripe_dashboard_reconciliation: {
      admin_shows_platform_available_only_pence: gbpAvail,
      platform_plus_connect_available_pence: gbpAvail + connectAvailableSum,
      platform_plus_connect_available_gbp: gbpSummary(gbpAvail + connectAvailableSum),
      future_payouts_listed_pence: futurePayoutsSum,
      future_payouts_listed_gbp: gbpSummary(futurePayoutsSum),
      pending_incoming_pence: gbpPending + connectPendingSum,
    },
    future_payouts: allFuturePayouts,
    orphan_risk_payouts: allFuturePayouts.filter((p) => p.orphan_payout_risk === true),
    automatic_payout_accounts: connectedAccounts.filter(
      (a) => a.automatic_payouts_enabled === true,
    ),
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
