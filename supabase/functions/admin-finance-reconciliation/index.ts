import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { computeSSOTMetrics } from "../_shared/financialReconciliationSSOT.ts";
import { fetchPerDriverFinancialReconciliation } from "../_shared/perDriverFinancialReconciliation.ts";
import {
  buildFinanceReconciliationSummary,
  classifyOnecabSettlementStatus,
  COUNTABLE_FINANCIAL_OUTCOMES,
  mapTripToFinancialAuditRow,
  sumCommissionableFromTrips,
  sumTripFinanceMetrics,
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

function settlementStatusLabel(status: string): string {
  switch (status) {
    case "calculated_only":
      return "Calculated only — not confirmed in Stripe";
    case "pending_stripe_settlement":
      return "Pending Stripe settlement";
    case "available_in_stripe_balance":
      return "ONECAB net available in Stripe (trip-verified)";
    case "paid_to_onecab_bank":
      return "Paid To ONECAB Bank";
    case "reconciled":
      return "Reconciled";
    default:
      return status;
  }
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
    const periodFrom = url.searchParams.get("from") || startOfTodayUtc();
    const periodTo = url.searchParams.get("to") || endOfTodayUtc();
    const driverId = url.searchParams.get("driver_id");
    const auditLimit = Math.min(Number(url.searchParams.get("audit_limit") || 100), 500);

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

    let tripQuery = supabase
      .from("trips")
      .select(`
        id,
        trip_code,
        commission_pence,
        stripe_processing_fee_pence,
        onecab_net_pence,
        driver_net_pence,
        gross_fare_pence,
        final_fare_pence,
        commissionable_fare_pence,
        capture_amount_pence,
        refund_amount_pence,
        pickup_waiting_charge_pence,
        stop_waiting_charge_pence,
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

    if (serviceAreaId) tripQuery = tripQuery.eq("service_area_id", serviceAreaId);
    else if (resolvedRegionId) {
      const { data: areas } = await supabase.from("service_areas").select("id").eq("region_id", resolvedRegionId);
      const ids = (areas || []).map((a) => a.id);
      if (ids.length > 0) tripQuery = tripQuery.in("service_area_id", ids);
    }

    const financialPromise = resolvedRegionId
      ? supabase
        .from("driver_financial_summary")
        .select("driver_id, wallet_balance, available_for_payout, net_available_for_payout, total_payouts_sent, reserved_cashout_pence, region_id")
        .eq("region_id", resolvedRegionId)
      : supabase
        .from("driver_financial_summary")
        .select("driver_id, wallet_balance, available_for_payout, net_available_for_payout, total_payouts_sent, reserved_cashout_pence, region_id");

    const financialResult = await financialPromise;
    if (financialResult.error) throw financialResult.error;

    const driverIds = financialResult.data?.map((d) => d.driver_id) ?? [];

    let ledgerQuery = supabase
      .from("driver_wallet_ledger")
      .select("type, amount_pence, driver_id")
      .gte("created_at", periodFrom)
      .lte("created_at", periodTo);

    if (driverIds.length > 0) {
      ledgerQuery = ledgerQuery.in("driver_id", driverIds);
    }

    const [
      tripResult,
      ledgerResult,
      pendingPayoutsResult,
      pendingCashoutsResult,
      webhookResult,
      failedWebhooksResult,
    ] = await Promise.all([
      tripQuery,
      ledgerQuery,
      supabase.from("payout_items").select("amount_pence").in("status", ["pending", "processing"]),
      supabase
        .from("driver_early_cashouts")
        .select("requested_cashout_pence, driver_receives_pence")
        .in("status", ["processing", "pending", "transfer_created"]),
      supabase
        .from("webhook_events")
        .select("created_at, status")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("webhook_events")
        .select("id", { count: "exact", head: true })
        .eq("status", "failed")
        .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    ]);

    if (tripResult.error) throw tripResult.error;
    if (ledgerResult.error) throw ledgerResult.error;

    const tripRows = (tripResult.data || []) as TripAuditSourceRow[];
    const finance = sumTripFinanceMetrics(tripRows);
    const commissionableRevenue = sumCommissionableFromTrips(tripRows);

    const tripIds = tripRows.map((t) => t.id);
    let paymentRows: Array<{ captured_amount_pence: number | null; status: string | null; trip_id: string | null }> = [];
    if (tripIds.length > 0) {
      const { data: payments, error: payErr } = await supabase
        .from("payments")
        .select("captured_amount_pence, status, trip_id")
        .in("trip_id", tripIds);
      if (payErr) throw payErr;
      paymentRows = payments || [];
    }

    const financialRows = financialResult.data || [];
    const walletBalance = financialRows.reduce((s, d) => s + Number(d.wallet_balance || 0), 0);
    const reservedCashout = financialRows.reduce((s, d) => s + Number(d.reserved_cashout_pence || 0), 0);

    const pendingPayout = (pendingPayoutsResult.data || []).reduce((s, p) => s + Number(p.amount_pence || 0), 0);
    const pendingCashout = (pendingCashoutsResult.data || []).reduce(
      (s, c) => s + Number(c.driver_receives_pence ?? c.requested_cashout_pence ?? 0),
      0,
    );
    const inFlightCashout = pendingCashout + reservedCashout;
    const pendingTransfers = pendingPayout + inFlightCashout;

    let stripeAvailablePence = 0;
    let stripePendingPence = 0;
    let stripeBalanceError: string | null = null;

    if (stripeSecretKey) {
      try {
        const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });
        const balance = await stripe.balance.retrieve();
        const avail = balance.available.find((b) => b.currency === currency);
        const pend = balance.pending.find((b) => b.currency === currency);
        stripeAvailablePence = avail?.amount ?? 0;
        stripePendingPence = pend?.amount ?? 0;
      } catch (e) {
        stripeBalanceError = (e as Error).message;
      }
    } else {
      stripeBalanceError = "STRIPE_SECRET_KEY not configured";
    }

    if (driverId) {
      const perDriver = await fetchPerDriverFinancialReconciliation(supabase, {
        driverId,
        regionId: resolvedRegionId,
        periodFrom,
        periodTo,
        providerAvailableBalancePence: stripeAvailablePence,
        providerPendingBalancePence: stripePendingPence,
        sourceTier: "LIVE",
      });

      return new Response(JSON.stringify({
        period: { from: periodFrom, to: periodTo },
        currency_code: currency.toUpperCase(),
        finance_reconciliation_driver_ssot: perDriver,
        meta: {
          driver_id: driverId,
          ssot_version: "financial_reconciliation_ssot_v1",
          data_source_badge: perDriver.source_tier,
          stripe_balance_error: stripeBalanceError,
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const settlementStatus = classifyOnecabSettlementStatus({
      calculatedOnecabNetPence: finance.onecab_net_pence,
      verifiedOnecabNetPence: finance.verified_onecab_net_pence,
      stripeAvailablePence,
      stripePendingPence,
      verifiedTripCount: finance.verified_trip_count,
      tripCount: finance.tripCount,
    });

    const failedWebhookCount = failedWebhooksResult.count ?? 0;
    const lastWebhookAt = webhookResult.data?.created_at ?? null;
    let providerHealth: "healthy" | "degraded" | "failing" | "unknown" = "unknown";
    if (stripeBalanceError) {
      providerHealth = "failing";
    } else if (failedWebhookCount > 0) {
      providerHealth = "degraded";
    } else if (lastWebhookAt) {
      providerHealth = "healthy";
    }

    const ssotMetrics = computeSSOTMetrics({
      payments: paymentRows,
      trips: tripRows,
      ledger: ledgerResult.data || [],
      providerAvailableBalancePence: stripeAvailablePence,
      providerPendingBalancePence: stripePendingPence,
    });

    const finance_reconciliation_summary = buildFinanceReconciliationSummary({
      ssot: ssotMetrics,
      commissionableRevenuePence: commissionableRevenue,
      driverWalletBalancePence: walletBalance,
      inFlightCashoutPence: inFlightCashout,
      settlementStatus,
      settlementStatusLabel: settlementStatusLabel(settlementStatus),
      providerHealthStatus: providerHealth,
      lastWebhookReceivedAt: lastWebhookAt,
      onecabBankPayoutPence: settlementStatus === "paid_to_onecab_bank" ? ssotMetrics.onecab_net_commission_pence : 0,
      dataSourceBadge: "LIVE",
    });

    const trip_financial_audit = tripRows.map(mapTripToFinancialAuditRow);

    return new Response(JSON.stringify({
      period: { from: periodFrom, to: periodTo },
      currency_code: currency.toUpperCase(),
      finance_reconciliation_summary,
      trip_financial_audit,
      meta: {
        trip_count: finance.tripCount,
        audit_row_count: trip_financial_audit.length,
        stripe_balance_error: stripeBalanceError,
        ssot_version: "financial_reconciliation_ssot_v1",
        data_source_badge: "LIVE",
        accounting_rules: {
          total_customer_revenue: "payments.captured_amount_pence → trips.capture → trips.final_fare",
          onecab_gross_commission: "sum(trips.commission_pence) — NEVER provider_balance or driver_liability",
          onecab_net_commission: "onecab_gross_commission_pence - provider_processing_fee_pence",
          driver_paid_out: "abs(sum(driver_wallet_ledger payout debits))",
          driver_remaining_liability: "driver_net_earnings - driver_paid_out + adjustments",
          driver_available_now: "min(driver_remaining_liability, provider_available_balance)",
          driver_pending_payout: "max(0, driver_remaining_liability - driver_available_now)",
          reconciliation_period:
            "net_customer_revenue = driver_net_earnings + onecab_gross_commission + tips (trip earnings in selected period)",
          reconciliation_cash:
            "net_customer_revenue = driver_paid_out + driver_remaining_liability + onecab_net_commission + provider_processing_fee (adjustments already in liability)",
        },
      },
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[admin-finance-reconciliation]", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
