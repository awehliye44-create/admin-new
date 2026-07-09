// v1.0.2 — resolve finance scope provider before platform balance fetch
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";
import {
  fetchProviderPlatformBalance,
  resolveFinanceScopeProvider,
} from "../_shared/providerPlatformBalanceSSOT.ts";
import {
  buildFinanceBackendAuditV1,
  type EarlyCashoutRow,
  type LedgerRow,
  type PayoutItemRow,
  sumLedgerWalletBalanceByDriver,
} from "../_shared/financeBackendAuditV1.ts";
import {
  COUNTABLE_FINANCIAL_OUTCOMES,
  type TripAuditSourceRow,
} from "../_shared/financeSettlementSummary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-region-id, x-service-area-id",
};

function startOfTodayUtc(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function endOfTodayUtc(): string {
  const d = new Date();
  d.setUTCHours(23, 59, 59, 999);
  return d.toISOString();
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
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: roleData } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();

    if (!roleData) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = new URL(req.url);
    const regionId = url.searchParams.get("region_id") || req.headers.get("x-region-id");
    const serviceAreaId = url.searchParams.get("service_area_id") || req.headers.get("x-service-area-id");
    const driverId = url.searchParams.get("driver_id");
    const periodFrom = url.searchParams.get("from") || startOfTodayUtc();
    const periodTo = url.searchParams.get("to") || endOfTodayUtc();
    const auditLimit = Math.min(Number(url.searchParams.get("audit_limit") || 500), 2000);

    let resolvedRegionId = regionId;
    if (!resolvedRegionId && serviceAreaId) {
      const { data: sa } = await supabase
        .from("service_areas")
        .select("region_id")
        .eq("id", serviceAreaId)
        .maybeSingle();
      resolvedRegionId = sa?.region_id ?? null;
    }

    let currency = "gbp";
    if (resolvedRegionId) {
      const { data: region } = await supabase
        .from("regions")
        .select("currency_code")
        .eq("id", resolvedRegionId)
        .maybeSingle();
      currency = (region?.currency_code || "gbp").toLowerCase();
    }

    let serviceAreaIds: string[] | null = null;
    if (serviceAreaId) {
      serviceAreaIds = [serviceAreaId];
    } else if (resolvedRegionId) {
      const { data: areas } = await supabase
        .from("service_areas")
        .select("id")
        .eq("region_id", resolvedRegionId);
      serviceAreaIds = (areas || []).map((a) => a.id);
    }

    let tripQuery = supabase
      .from("trips")
      .select(`
        id,
        trip_code,
        driver_id,
        commission_pence,
        stripe_processing_fee_pence,
        onecab_net_pence,
        driver_net_pence,
        gross_fare_pence,
        final_fare_pence,
        commissionable_fare_pence,
        capture_amount_pence,
        refund_amount_pence,
        airport_charge_pence,
        other_pass_through_charges_pence,
        tip_pence,
        tip_amount_pence,
        payment_method,
        payment_status,
        financial_outcome,
        stripe_settlement_verified,
        driver_tier_commission_percent,
        commission_pct,
        completed_at,
        service_area_id,
        driver:drivers!trips_driver_id_fkey(first_name, last_name)
      `)
      .gte("completed_at", periodFrom)
      .lte("completed_at", periodTo)
      .or(`financial_outcome.in.(${COUNTABLE_FINANCIAL_OUTCOMES.join(",")}),status.in.(completed,no_show)`)
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(auditLimit);

    if (serviceAreaIds?.length) tripQuery = tripQuery.in("service_area_id", serviceAreaIds);
    if (driverId) tripQuery = tripQuery.eq("driver_id", driverId);

    let ledgerQuery = supabase
      .from("driver_wallet_ledger")
      .select("id, driver_id, type, amount_pence, stripe_transfer_id, stripe_payout_id, created_at")
      .gte("created_at", periodFrom)
      .lte("created_at", periodTo)
      .order("created_at", { ascending: false })
      .limit(5000);

    if (driverId) ledgerQuery = ledgerQuery.eq("driver_id", driverId);

    let payoutQuery = supabase
      .from("payout_items")
      .select(`
        id,
        driver_id,
        trip_id,
        amount_pence,
        driver_amount_pence,
        status,
        stripe_transfer_id,
        stripe_payout_id,
        ledger_entry_id,
        created_at,
        completed_at,
        error_message,
        payout_batches(kind)
      `)
      .gte("created_at", periodFrom)
      .lte("created_at", periodTo)
      .order("created_at", { ascending: false })
      .limit(auditLimit);

    if (driverId) payoutQuery = payoutQuery.eq("driver_id", driverId);

    let cashoutQuery = supabase
      .from("driver_early_cashouts")
      .select(`
        id,
        driver_id,
        status,
        requested_cashout_pence,
        driver_receives_pence,
        stripe_transfer_id,
        stripe_payout_id,
        ledger_cashout_id,
        created_at,
        paid_at
      `)
      .gte("created_at", periodFrom)
      .lte("created_at", periodTo)
      .order("created_at", { ascending: false })
      .limit(auditLimit);

    if (driverId) cashoutQuery = cashoutQuery.eq("driver_id", driverId);

    let walletQuery = supabase
      .from("driver_wallets")
      .select("driver_id, available_pence");

    if (driverId) walletQuery = walletQuery.eq("driver_id", driverId);

    let driversQuery = supabase.from("drivers").select("id, first_name, last_name").limit(5000);
    if (driverId) driversQuery = driversQuery.eq("id", driverId);

    let walletLedgerQuery = supabase
      .from("driver_wallet_ledger")
      .select("driver_id, type, amount_pence");
    if (driverId) walletLedgerQuery = walletLedgerQuery.eq("driver_id", driverId);

    const [
      tripResult,
      ledgerResult,
      payoutResult,
      cashoutResult,
      walletResult,
      driversResult,
      walletLedgerResult,
    ] = await Promise.all([
      tripQuery,
      ledgerQuery,
      payoutQuery,
      cashoutQuery,
      walletQuery,
      driversQuery,
      walletLedgerQuery,
    ]);

    if (tripResult.error) throw tripResult.error;
    if (ledgerResult.error) throw ledgerResult.error;
    if (payoutResult.error) throw payoutResult.error;
    if (cashoutResult.error) throw cashoutResult.error;
    if (walletResult.error) throw walletResult.error;
    if (driversResult.error) throw driversResult.error;
    if (walletLedgerResult.error) throw walletLedgerResult.error;

    const trips = (tripResult.data || []) as TripAuditSourceRow[];
    const tripIds = trips.map((t) => t.id);
    let paymentRows: Array<{
      trip_id: string | null;
      captured_amount_pence: number | null;
      status: string | null;
    }> = [];
    if (tripIds.length > 0) {
      const { data: payments, error: paymentsErr } = await supabase
        .from("payments")
        .select("trip_id, captured_amount_pence, status")
        .in("trip_id", tripIds);
      if (paymentsErr) throw paymentsErr;
      paymentRows = payments ?? [];
    }

    const ledgerRows = (ledgerResult.data || []) as LedgerRow[];
    const payoutItems = ((payoutResult.data || []) as Array<PayoutItemRow & {
      payout_batches?: { kind?: string | null } | null;
    }>).map((item) => ({
      ...item,
      batch: item.payout_batches ?? item.batch ?? null,
    })) as PayoutItemRow[];
    const earlyCashouts = (cashoutResult.data || []) as EarlyCashoutRow[];

    const walletByDriver = new Map<string, number>();
    for (const w of walletResult.data || []) {
      walletByDriver.set(w.driver_id, Number(w.available_pence || 0));
    }

    const ledgerWalletSumByDriver = sumLedgerWalletBalanceByDriver(
      walletLedgerResult.data || [],
    );

    let stripeAvailablePence = 0;
    let stripePendingPence = 0;
    let stripePlatformPayoutsPence = 0;
    let stripePlatformPaidTodayPence = 0;
    let stripePlatformPayoutDetails: Array<{
      id: string;
      amount_pence: number;
      status: string;
      arrival_date: string | null;
      created_at: string;
    }> = [];
    let stripeBalanceError: string | null = null;

    const financeScopeProvider = await resolveFinanceScopeProvider(supabase, {
      regionId: resolvedRegionId,
      serviceAreaId: serviceAreaId ?? null,
    });

    const providerBalance = await fetchProviderPlatformBalance(supabase, {
      provider: financeScopeProvider.provider,
      environment: financeScopeProvider.environment,
      currency,
    });
    stripeAvailablePence = providerBalance.available_pence;
    stripePendingPence = providerBalance.pending_pence;
    stripeBalanceError = providerBalance.error;

    const useStripePlatformPayouts = financeScopeProvider.provider === "stripe";

    if (useStripePlatformPayouts && stripeSecretKey) {
      try {
        const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });
        const payouts = await stripe.payouts.list({ limit: 100 });
        stripePlatformPayoutsPence = payouts.data
          .filter((p: { currency: string; status: string }) => p.currency === currency && p.status === "paid")
          .reduce((s: number, p: { amount?: number | null }) => s + (p.amount ?? 0), 0);

        const londonTodayStartMs = (() => {
          const now = new Date();
          const london = new Date(
            now.toLocaleString("en-US", { timeZone: "Europe/London" }),
          );
          london.setHours(0, 0, 0, 0);
          return london.getTime();
        })();

        stripePlatformPayoutDetails = payouts.data
          .filter((p: { currency: string }) => p.currency === currency)
          .map((p: {
            id: string;
            amount?: number | null;
            status: string;
            arrival_date?: number | null;
            created: number;
          }) => ({
            id: p.id,
            amount_pence: p.amount ?? 0,
            status: p.status,
            arrival_date: p.arrival_date
              ? new Date(p.arrival_date * 1000).toISOString()
              : null,
            created_at: new Date(p.created * 1000).toISOString(),
          }));

        stripePlatformPaidTodayPence = stripePlatformPayoutDetails
          .filter(
            (p) =>
              p.status === "paid" &&
              p.arrival_date &&
              new Date(p.arrival_date).getTime() >= londonTodayStartMs,
          )
          .reduce((s, p) => s + p.amount_pence, 0);
      } catch (e) {
        stripeBalanceError = (e as Error).message;
      }
    } else if (useStripePlatformPayouts && !stripeSecretKey) {
      stripeBalanceError = stripeBalanceError ?? "STRIPE_SECRET_KEY not configured";
    }

    const finance_backend_audit_v1 = buildFinanceBackendAuditV1({
      period: { from: periodFrom, to: periodTo },
      currencyCode: currency,
      trips,
      payments: paymentRows,
      ledgerRows,
      payoutItems,
      earlyCashouts,
      walletByDriver,
      ledgerWalletSumByDriver,
      drivers: driversResult.data || [],
      stripeAvailablePence,
      stripePendingPence,
      stripePlatformPayoutsPence,
      stripeBalanceError,
    });

    return new Response(JSON.stringify({
      finance_backend_audit_v1,
      stripe_platform_payouts: {
        paid_today_pence: stripePlatformPaidTodayPence,
        paid_all_time_pence: stripePlatformPayoutsPence,
        recent: stripePlatformPayoutDetails.slice(0, 20),
        note:
          "Stripe automatic platform payouts to ONECAB business bank — not the same as admin commission-sweep batches.",
      },
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[finance-backend-audit-v1]", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
