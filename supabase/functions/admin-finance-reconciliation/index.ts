import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";
import {
  buildFinanceReconciliationSummary,
  classifyOnecabSettlementStatus,
  COUNTABLE_FINANCIAL_OUTCOMES,
  mapTripToFinancialAuditRow,
  sumCommissionableFromTrips,
  sumRefundedAmountPence,
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

    const [
      tripResult,
      financialResult,
      pendingPayoutsResult,
      pendingCashoutsResult,
      webhookResult,
      failedWebhooksResult,
    ] = await Promise.all([
      tripQuery,
      financialPromise,
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
    if (financialResult.error) throw financialResult.error;

    const tripRows = (tripResult.data || []) as TripAuditSourceRow[];
    const finance = sumTripFinanceMetrics(tripRows);
    const refundedAmount = sumRefundedAmountPence(tripRows);
    const commissionableRevenue = sumCommissionableFromTrips(tripRows);

    const financialRows = financialResult.data || [];
    const walletBalance = financialRows.reduce((s, d) => s + Number(d.wallet_balance || 0), 0);
    const settledEligible = financialRows.reduce(
      (s, d) => s + Number(d.net_available_for_payout ?? d.available_for_payout ?? 0),
      0,
    );
    const paidOut = financialRows.reduce((s, d) => s + Number(d.total_payouts_sent || 0), 0);
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

    const finance_reconciliation_summary = buildFinanceReconciliationSummary({
      tripMetrics: finance,
      refundedAmountPence: refundedAmount,
      commissionableRevenuePence: commissionableRevenue,
      driverWalletBalancePence: walletBalance,
      driverSettledEligiblePence: settledEligible,
      driverPaidOutPence: paidOut,
      inFlightCashoutPence: inFlightCashout,
      pendingTransfersPence: pendingTransfers,
      stripeAvailablePence,
      stripePendingPence,
      settlementStatus,
      settlementStatusLabel: settlementStatusLabel(settlementStatus),
      providerHealthStatus: providerHealth,
      lastWebhookReceivedAt: lastWebhookAt,
      adjustmentsPence: 0,
      onecabBankPayoutPence: settlementStatus === "paid_to_onecab_bank" ? finance.onecab_net_pence : 0,
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
        accounting_rules: {
          total_customer_revenue: "sum(capture_amount_pence)",
          onecab_gross_commission: "sum(trips.commission_pence) — never Stripe balance − driver payable",
          onecab_net_commission: "onecab_gross_commission_pence - provider_processing_fee_pence",
          driver_available_payout:
            "min(driver_settled_eligible_balance_pence, provider_available_balance_pence) - in_flight_cashout_pence",
          reconciliation:
            "net_customer_revenue = driver_net + onecab_gross_commission + adjustments (processing fee is inside gross commission)",
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
