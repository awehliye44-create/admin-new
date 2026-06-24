import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";
import {
  listInFlightConnectPayouts,
  readConnectPayoutSnapshot,
} from "../_shared/connectPayoutLockdown.ts";
import { fetchPerDriverFinancialReconciliation } from "../_shared/perDriverFinancialReconciliation.ts";
import {
  computeMaxManualConnectPayoutPence,
  evaluateConnectManualPayoutGate,
} from "../_shared/connectManualPayout.ts";

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

function connectAccountStatusLabel(account: Stripe.Account): string {
  if (account.requirements?.disabled_reason) return `restricted:${account.requirements.disabled_reason}`;
  if ((account.requirements?.currently_due?.length ?? 0) > 0) return "requirements_due";
  if (account.payouts_enabled && account.charges_enabled) return "active";
  if (!account.details_submitted) return "onboarding";
  return "pending";
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
      .select("id, driver_code, first_name, last_name, stripe_account_id, region_id, payouts_enabled, charges_enabled, regions(currency_code)")
      .not("stripe_account_id", "is", null);

    if (driverId) driverQuery = driverQuery.eq("id", driverId);
    if (regionId) driverQuery = driverQuery.eq("region_id", regionId);

    const { data: drivers, error: driversError } = await driverQuery;
    if (driversError) throw driversError;

    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });
    const platformAccount = await stripe.accounts.retrieve();
    const platformBalance = await stripe.balance.retrieve();
    const platformAvailable = platformBalance.available.find((b) => b.currency === "gbp")?.amount ?? 0;
    const platformPending = platformBalance.pending.find((b) => b.currency === "gbp")?.amount ?? 0;

    const accounts: Array<Record<string, unknown>> = [];

    for (const driver of drivers ?? []) {
      const acct = driver.stripe_account_id as string;
      if (acct === platformAccount.id) continue;

      const regionData = driver.regions as { currency_code?: string } | null;
      const currency = (regionData?.currency_code ?? "gbp").toLowerCase();

      const account = await stripe.accounts.retrieve(acct);
      const snapshot = await readConnectPayoutSnapshot(stripe, acct);
      const inFlight = await listInFlightConnectPayouts(stripe, acct);

      const finance = await fetchPerDriverFinancialReconciliation(supabase, {
        driverId: driver.id,
        regionId: driver.region_id,
        providerAvailableBalancePence: platformAvailable,
        providerPendingBalancePence: platformPending,
        sourceTier: "LIVE",
      });

      const { data: summaryRow } = await supabase
        .from("driver_financial_summary")
        .select("wallet_balance, amount_owed_to_onecab")
        .eq("driver_id", driver.id)
        .maybeSingle();

      const walletBalance = Number(
        finance.driver_wallet_balance_pence ?? summaryRow?.wallet_balance ?? 0,
      );
      const availableNow = finance.driver_available_now_pence;
      const awaitingSettlement = Math.max(0, walletBalance - availableNow);
      const connectAvailable = snapshot.available_pence;
      const walletConnectDifference = connectAvailable - walletBalance;

      const { data: lastTransferItem } = await supabase
        .from("payout_items")
        .select("stripe_transfer_id, amount_pence, net_driver_payout_pence, created_at, completed_at")
        .eq("driver_id", driver.id)
        .not("stripe_transfer_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: lastPayoutItem } = await supabase
        .from("payout_items")
        .select("stripe_payout_id, amount_pence, net_driver_payout_pence, status, provider_status, created_at, completed_at")
        .eq("driver_id", driver.id)
        .not("stripe_payout_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

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

      const accountRestricted = (account.requirements?.currently_due?.length ?? 0) > 0
        || account.requirements?.disabled_reason != null;

      const manualGate = evaluateConnectManualPayoutGate({
        wallet_balance_pence: walletBalance,
        driver_available_now_pence: availableNow,
        connect_available_pence: connectAvailable,
        payouts_enabled: snapshot.payouts_enabled === true,
        charges_enabled: account.charges_enabled === true,
        stripe_account_id: acct,
        account_restricted: accountRestricted,
        payout_blocked: finance.payout_blocked,
        reconciliation_status: finance.reconciliation_status,
        outstanding_debt_pence: Number(summaryRow?.amount_owed_to_onecab ?? 0),
      });

      accounts.push({
        driver_id: driver.id,
        driver_code: driver.driver_code,
        driver_name: `${driver.first_name ?? ""} ${driver.last_name ?? ""}`.trim(),
        stripe_account_id: acct,
        connect_account_status: connectAccountStatusLabel(account),
        connect_account_type: account.type,
        charges_enabled: account.charges_enabled ?? false,
        payouts_enabled: snapshot.payouts_enabled ?? false,
        db_payouts_enabled: driver.payouts_enabled,
        requirements_due: account.requirements?.currently_due ?? [],
        currency,
        connect_available_pence: connectAvailable,
        connect_pending_pence: snapshot.pending_pence,
        wallet_balance_pence: walletBalance,
        onecab_available_now_pence: availableNow,
        awaiting_settlement_pence: awaitingSettlement,
        wallet_connect_difference_pence: walletConnectDifference,
        max_manual_connect_payout_pence: manualGate.max_manual_payout_pence,
        manual_connect_payout_allowed: manualGate.allowed,
        manual_connect_payout_block_reasons: manualGate.block_reasons,
        payout_blocked: finance.payout_blocked,
        payout_blocked_reasons: finance.payout_blocked_reasons,
        reconciliation_status: finance.reconciliation_status,
        last_stripe_transfer_id: lastTransferItem?.stripe_transfer_id ?? null,
        last_transfer_amount_pence: lastTransferItem?.net_driver_payout_pence
          ?? lastTransferItem?.amount_pence ?? null,
        last_transfer_date: lastTransferItem?.completed_at ?? lastTransferItem?.created_at ?? null,
        last_payout_id: lastPayoutItem?.stripe_payout_id ?? null,
        last_payout_status: lastPayoutItem?.provider_status ?? lastPayoutItem?.status ?? null,
        last_payout_amount_pence: lastPayoutItem?.net_driver_payout_pence
          ?? lastPayoutItem?.amount_pence ?? null,
        last_payout_date: lastPayoutItem?.completed_at ?? lastPayoutItem?.created_at ?? null,
        payout_mode: snapshot.interval === "manual" ? "manual" : "automatic",
        payout_schedule_interval: snapshot.interval,
        payout_schedule_delay_days: snapshot.delay_days,
        automatic_payouts_enabled: snapshot.automatic_payouts_enabled,
        in_flight_payouts: inFlight.map((p) => ({
          ...p,
          in_ledger: ledgerSet.has(p.payout_id),
          in_payout_items: itemSet.has(p.payout_id),
          orphan_risk: !ledgerSet.has(p.payout_id) && !itemSet.has(p.payout_id),
        })),
      });
    }

    return new Response(JSON.stringify({
      phase: "connect_balance_visibility",
      read_only: true,
      ssot_note: {
        wallet_balance: "driver_wallet_ledger — what ONECAB owes the driver",
        onecab_available_now: "finance reconciliation driver_available_now — withdrawal cap (unchanged)",
        connect_available: "Stripe Connect balance.available — where cash sits on Connect (visibility only)",
      },
      platform_stripe: {
        available_pence: platformAvailable,
        pending_pence: platformPending,
      },
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
        total_connect_available_pence: accounts.reduce(
          (s, a) => s + Number(a.connect_available_pence ?? 0),
          0,
        ),
      },
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
