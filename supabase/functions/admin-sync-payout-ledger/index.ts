import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { retryPayoutLedgerSync } from "../_shared/payoutLedgerSync.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function isServiceRoleToken(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload?.role === "service_role";
  } catch {
    return false;
  }
}

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

async function discoverOrphanStripePayouts(args: {
  supabase: ReturnType<typeof createClient>;
  stripe: Stripe;
  driverId: string;
  stripeAccountId: string;
  currency: string;
}): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = [];

  // Only bank payouts on the connected account are wallet debits.
  // Platform→connected transfers are trip settlements and must NOT be debited here.
  const payouts = await args.stripe.payouts.list(
    { limit: 100 },
    { stripeAccount: args.stripeAccountId },
  );

  for (const payout of payouts.data) {
    if (payout.currency !== args.currency.toLowerCase() || payout.status !== "paid") continue;

    const { data: existing } = await args.supabase
      .from("driver_wallet_ledger")
      .select("id")
      .eq("stripe_payout_id", payout.id)
      .maybeSingle();

    if (existing?.id) continue;

    const { data: ledgerId, error } = await args.supabase.rpc(
      "insert_payout_ledger_debit_if_missing",
      {
        p_driver_id: args.driverId,
        p_amount_pence: -(payout.amount ?? 0),
        p_ledger_type: "WEEKLY_PAYOUT",
        p_currency: args.currency,
        p_description: "Weekly payout to bank",
        p_stripe_transfer_id: null,
        p_stripe_payout_id: payout.id,
        p_paid_at: payout.arrival_date
          ? new Date(payout.arrival_date * 1000).toISOString()
          : new Date().toISOString(),
      },
    );

    if (error) {
      results.push({ payout_id: payout.id, success: false, error: error.message });
      continue;
    }

    await args.supabase.rpc("recalculate_driver_wallet", { p_driver_id: args.driverId });

    results.push({
      payout_id: payout.id,
      amount_pence: payout.amount,
      success: true,
      ledger_entry_id: ledgerId,
    });
  }

  return results;
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

    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "") ?? "";
    const isServiceRole = token === supabaseServiceKey || isServiceRoleToken(token);
    const admin = isServiceRole ? { id: "service_role" } : await verifyAdmin(supabase, authHeader);
    if (!admin) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = req.method === "POST" ? await req.json() : {};
    const payoutItemId = body.payout_item_id as string | undefined;
    const driverId = body.driver_id as string | undefined;
    const discoverStripe = body.discover_stripe === true;

    if (payoutItemId) {
      const result = await retryPayoutLedgerSync(supabase, payoutItemId);
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (discoverStripe && driverId && stripeSecretKey) {
      const { data: driver, error: driverError } = await supabase
        .from("drivers")
        .select("id, stripe_account_id, region:regions(currency_code)")
        .eq("id", driverId)
        .single();

      if (driverError || !driver?.stripe_account_id) {
        return new Response(JSON.stringify({ error: "Driver or Stripe account not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });
      const currency = (driver.region as { currency_code?: string } | null)?.currency_code ?? "gbp";
      const discovered = await discoverOrphanStripePayouts({
        supabase,
        stripe,
        driverId,
        stripeAccountId: driver.stripe_account_id,
        currency,
      });

      const { data: wallet } = await supabase
        .from("driver_wallets")
        .select("available_pence")
        .eq("driver_id", driverId)
        .maybeSingle();

      return new Response(JSON.stringify({
        ok: true,
        discovered,
        wallet_available_pence: wallet?.available_pence ?? null,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      error: "Provide payout_item_id or { driver_id, discover_stripe: true }",
    }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[admin-sync-payout-ledger]", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
