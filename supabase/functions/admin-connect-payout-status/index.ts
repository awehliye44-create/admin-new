import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";
import {
  listInFlightConnectPayouts,
  readConnectPayoutSnapshot,
} from "../_shared/connectPayoutLockdown.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function verifyAdmin(supabase: ReturnType<typeof createClient>, authHeader: string | null) {
  if (!authHeader) return null;
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  const { data: roleData } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .maybeSingle();
  return roleData ? user : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const user = await verifyAdmin(supabase, req.headers.get("Authorization"));
    if (!user) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!stripeSecretKey) {
      return new Response(JSON.stringify({ error: "STRIPE_SECRET_KEY missing" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const url = new URL(req.url);
    const regionId = (body.region_id as string | undefined) ?? url.searchParams.get("region_id") ?? undefined;
    const driverId = (body.driver_id as string | undefined) ?? url.searchParams.get("driver_id") ?? undefined;

    let driverQuery = supabase
      .from("drivers")
      .select("id, driver_code, first_name, last_name, stripe_account_id, region_id, payouts_enabled")
      .not("stripe_account_id", "is", null);

    if (driverId) driverQuery = driverQuery.eq("id", driverId);
    if (regionId) driverQuery = driverQuery.eq("region_id", regionId);

    const { data: drivers, error: driversError } = await driverQuery;
    if (driversError) throw driversError;

    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });
    const platformAccount = await stripe.accounts.retrieve();

    const accounts: Array<Record<string, unknown>> = [];

    for (const driver of drivers ?? []) {
      const acct = driver.stripe_account_id as string;
      if (acct === platformAccount.id) continue;

      const snapshot = await readConnectPayoutSnapshot(stripe, acct);
      const inFlight = await listInFlightConnectPayouts(stripe, acct);

      const { data: ledgerRows } = await supabase
        .from("driver_wallet_ledger")
        .select("stripe_payout_id")
        .eq("driver_id", driver.id)
        .not("stripe_payout_id", "is", null);

      const { data: payoutItems } = await supabase
        .from("payout_items")
        .select("stripe_payout_id, status")
        .eq("driver_id", driver.id)
        .not("stripe_payout_id", "is", null);

      const ledgerSet = new Set((ledgerRows ?? []).map((r) => r.stripe_payout_id));
      const itemSet = new Set((payoutItems ?? []).map((r) => r.stripe_payout_id));

      const { data: lastAudit } = await supabase
        .from("stripe_connect_payout_schedule_audit")
        .select("action, after_interval, dry_run, created_at")
        .eq("driver_id", driver.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      accounts.push({
        driver_id: driver.id,
        driver_code: driver.driver_code,
        driver_name: `${driver.first_name ?? ""} ${driver.last_name ?? ""}`.trim(),
        stripe_account_id: acct,
        db_payouts_enabled: driver.payouts_enabled,
        payout_mode: snapshot.interval === "manual" ? "manual" : "automatic",
        payout_schedule_interval: snapshot.interval,
        payout_schedule_delay_days: snapshot.delay_days,
        automatic_payouts_enabled: snapshot.automatic_payouts_enabled,
        connect_available_pence: snapshot.available_pence,
        connect_pending_pence: snapshot.pending_pence,
        in_flight_payouts: inFlight.map((p) => ({
          ...p,
          in_ledger: ledgerSet.has(p.payout_id),
          in_payout_items: itemSet.has(p.payout_id),
          orphan_risk: !ledgerSet.has(p.payout_id) && !itemSet.has(p.payout_id),
        })),
        last_lockdown_audit: lastAudit,
      });
    }

    const { data: recentAudits } = await supabase
      .from("stripe_connect_payout_schedule_audit")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20);

    return new Response(JSON.stringify({
      phase: "3D.3",
      read_only: true,
      timestamp: new Date().toISOString(),
      connect_accounts: accounts,
      summary: {
        total: accounts.length,
        automatic_count: accounts.filter((a) => a.automatic_payouts_enabled === true).length,
        manual_count: accounts.filter((a) => a.automatic_payouts_enabled === false).length,
        in_flight_count: accounts.reduce(
          (s, a) => s + ((a.in_flight_payouts as unknown[])?.length ?? 0),
          0,
        ),
      },
      recent_audits: recentAudits ?? [],
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[admin-connect-payout-status]", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
