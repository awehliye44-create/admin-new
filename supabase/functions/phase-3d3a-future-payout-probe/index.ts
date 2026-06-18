/**
 * One-shot read-only: future payout / platform schedule probe (3D.3A).
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

function fmt(p: number): string {
  return `£${(p / 100).toFixed(2)}`;
}

function isoFromUnix(ts: number | null | undefined): string | null {
  if (!ts) return null;
  return new Date(ts * 1000).toISOString();
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
  const platformAvail = platformBalance.available.find((b) => b.currency === "gbp")?.amount ?? 0;
  const platformPending = platformBalance.pending.find((b) => b.currency === "gbp")?.amount ?? 0;

  const platformAccount = await stripe.accounts.retrieve();
  const platformSchedule = platformAccount.settings?.payouts?.schedule;
  const platformAuto = platformSchedule?.interval !== "manual";

  const listPayouts = async (opts: { stripeAccount?: string }) => {
    const rows: Array<Record<string, unknown>> = [];
    for (const status of ["pending", "in_transit"] as const) {
      const page = await stripe.payouts.list({ limit: 100, status }, opts.stripeAccount
        ? { stripeAccount: opts.stripeAccount }
        : undefined);
      for (const p of page.data) {
        rows.push({
          payout_id: p.id,
          amount_pence: p.amount,
          amount_gbp: fmt(p.amount),
          status: p.status,
          automatic: p.automatic,
          method: p.method,
          arrival_date: isoFromUnix(p.arrival_date),
          arrival_date_unix: p.arrival_date,
          created: isoFromUnix(p.created),
          created_unix: p.created,
        });
      }
    }
    return rows;
  };

  const platformFuture = await listPayouts({});
  const { data: drivers } = await supabase
    .from("drivers")
    .select("id, driver_code, first_name, last_name, stripe_account_id, region_id")
    .not("stripe_account_id", "is", null);

  const connectFuture: Array<Record<string, unknown>> = [];
  const connectAccounts: Array<Record<string, unknown>> = [];

  for (const d of drivers ?? []) {
    const acct = d.stripe_account_id as string;
    const account = await stripe.accounts.retrieve(acct);
    const schedule = account.settings?.payouts?.schedule;
    const bal = await stripe.balance.retrieve({ stripeAccount: acct });
    const avail = bal.available.find((b) => b.currency === "gbp")?.amount ?? 0;
    const pend = bal.pending.find((b) => b.currency === "gbp")?.amount ?? 0;
    const payouts = await listPayouts({ stripeAccount: acct });

    connectAccounts.push({
      driver_code: d.driver_code,
      driver_id: d.id,
      stripe_account_id: acct,
      payout_schedule_interval: schedule?.interval ?? null,
      payout_schedule_delay_days: schedule?.delay_days ?? null,
      automatic_payouts_enabled: schedule?.interval !== "manual",
      available_pence: avail,
      available_gbp: fmt(avail),
      pending_pence: pend,
      pending_gbp: fmt(pend),
      avail_plus_pending_pence: avail + pend,
      avail_plus_pending_gbp: fmt(avail + pend),
    });

    for (const p of payouts) {
      connectFuture.push({
        ...p,
        owner_type: "connected_account",
        owner: d.driver_code ?? d.id,
        driver_id: d.id,
        driver_name: `${d.first_name ?? ""} ${d.last_name ?? ""}`.trim(),
        stripe_account_id: acct,
      });
    }
  }

  const allFuture = [
    ...platformFuture.map((p) => ({ ...p, owner_type: "platform", owner: "ONECAB platform" })),
    ...connectFuture,
  ];

  const sumFutureObjects = allFuture.reduce((s, p) => s + Number(p.amount_pence ?? 0), 0);

  return new Response(JSON.stringify({
    audit: "phase_3d3a_future_payout_probe",
    timestamp: new Date().toISOString(),
    stripe_dashboard_future_payouts_hypothesis: {
      user_reported_gbp: "£7.79",
      user_reported_pence: 779,
      platform_available_pence: platformAvail,
      platform_pending_pence: platformPending,
      platform_avail_plus_pending_pence: platformAvail + platformPending,
      platform_avail_plus_pending_gbp: fmt(platformAvail + platformPending),
      exact_match: platformAvail + platformPending === 779,
      interpretation:
        "Stripe Dashboard 'Future payouts' may aggregate platform available + incoming/pending, not a single payout object",
    },
    admin_provider_available: {
      pence: platformAvail,
      gbp: fmt(platformAvail),
      relationship:
        "Provider Available = platform available only; Future Payouts £7.79 ≈ Provider Available + Incoming (£6.66 + £1.13)",
    },
    platform_account: {
      id: platformAccount.id,
      payout_schedule_interval: platformSchedule?.interval ?? null,
      payout_schedule_delay_days: platformSchedule?.delay_days ?? null,
      automatic_payouts_enabled: platformAuto,
      available_pence: platformAvail,
      pending_pence: platformPending,
      pending_in_transit_payout_objects: platformFuture,
    },
    connect_accounts: connectAccounts,
    all_scheduled_payout_objects: allFuture,
    sum_scheduled_payout_objects_pence: sumFutureObjects,
    sum_scheduled_payout_objects_gbp: fmt(sumFutureObjects),
    automatic_payout_capability: {
      platform_auto_to_onecab_bank: platformAuto,
      connect_auto_enabled_accounts: connectAccounts.filter((a) => a.automatic_payouts_enabled === true),
      can_leave_stripe_without_admin_approval: true,
      reason:
        "Connect daily auto-sweep still enabled on MK0001/MK0002; MK0001 pending Connect balance £9.54 can auto-pay. Platform auto may sweep £6.66+£1.13 to ONECAB bank.",
    },
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
