import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  fetchProviderPlatformBalance,
  resolveFinanceScopeProvider,
} from "../_shared/providerPlatformBalanceSSOT.ts";
import {
  buildInsufficientFundsDiagnosis,
  classifyOnecabSettlementStatus,
  computeSafePayoutAmount,
  COUNTABLE_FINANCIAL_OUTCOMES,
  parseInsufficientFundsReason,
  partitionStripePlatformCash,
  reconcileStripeBalance,
  sumTripFinanceMetrics,
  type OnecabSettlementStatus,
  type PayoutFailureRow,
  type TripFinanceRow,
} from "../_shared/financeSettlementSummary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-region-id, x-service-area-id",
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
        commission_pence,
        stripe_processing_fee_pence,
        onecab_net_pence,
        driver_net_pence,
        gross_fare_pence,
        final_fare_pence,
        commissionable_fare_pence,
        capture_amount_pence,
        tip_pence,
        tip_amount_pence,
        payment_method,
        stripe_settlement_verified,
        driver_tier_commission_percent,
        commission_pct,
        payment_status,
        completed_at,
        service_area_id
      `)
      .gte("completed_at", periodFrom)
      .lte("completed_at", periodTo)
      .or(`financial_outcome.in.(${COUNTABLE_FINANCIAL_OUTCOMES.join(",")}),status.in.(completed,no_show)`)
      .not("completed_at", "is", null);

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

    const todayStart = startOfTodayUtc();

    const [
      tripResult,
      financialResult,
      failedPayoutsResult,
      pendingPayoutsResult,
      pendingCashoutsResult,
    ] = await Promise.all([
      tripQuery,
      financialPromise,
      supabase
        .from("payout_items")
        .select("amount_pence, error_message, created_at, drivers:driver_id(region_id)")
        .eq("status", "failed")
        .gte("created_at", todayStart)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("payout_items")
        .select("amount_pence")
        .in("status", ["pending", "processing"]),
      supabase
        .from("driver_early_cashouts")
        .select("requested_cashout_pence, driver_receives_pence")
        .in("status", ["processing", "pending", "transfer_created"]),
    ]);

    if (tripResult.error) throw tripResult.error;
    if (financialResult.error) throw financialResult.error;

    const tripRows = (tripResult.data || []) as TripFinanceRow[];
    const finance = sumTripFinanceMetrics(tripRows);

    const financialRows = financialResult.data || [];
    const walletBalance = financialRows.reduce((s, d) => s + Number(d.wallet_balance || 0), 0);
    const availablePayout = financialRows.reduce(
      (s, d) => s + Number(d.net_available_for_payout ?? d.available_for_payout ?? 0),
      0,
    );
    const paidOut = financialRows.reduce((s, d) => s + Number(d.total_payouts_sent || 0), 0);
    const reservedCashout = financialRows.reduce((s, d) => s + Number(d.reserved_cashout_pence || 0), 0);

    const failedItems = (failedPayoutsResult.data || []) as Array<PayoutFailureRow & { drivers?: { region_id?: string } | null }>;
    const scopedFailed = resolvedRegionId
      ? failedItems.filter((f) => f.drivers?.region_id === resolvedRegionId)
      : failedItems;
    const failedAmount = scopedFailed.reduce((s, f) => s + Number(f.amount_pence || 0), 0);

    const failureReasonMap = new Map<string, { amount_pence: number; count: number }>();
    for (const item of scopedFailed) {
      const key = parseInsufficientFundsReason(item.error_message) || item.error_message || "Unknown failure";
      const prev = failureReasonMap.get(key) || { amount_pence: 0, count: 0 };
      failureReasonMap.set(key, {
        amount_pence: prev.amount_pence + Number(item.amount_pence || 0),
        count: prev.count + 1,
      });
    }

    const pendingPayout = (pendingPayoutsResult.data || []).reduce((s, p) => s + Number(p.amount_pence || 0), 0);
    const pendingCashout = (pendingCashoutsResult.data || []).reduce(
      (s, c) => s + Number(c.driver_receives_pence ?? c.requested_cashout_pence ?? 0),
      0,
    );
    const pendingTransfers = pendingPayout + pendingCashout + reservedCashout;

    let stripeAvailablePence = 0;
    let stripePendingPence = 0;
    let stripeBalanceError: string | null = null;

    const financeScope = await resolveFinanceScopeProvider(supabase, {
      regionId: resolvedRegionId,
      serviceAreaId: serviceAreaId ?? null,
    });
    const providerBalance = await fetchProviderPlatformBalance(supabase, {
      provider: financeScope.provider,
      environment: financeScope.environment,
      currency,
    });
    stripeAvailablePence = providerBalance.available_pence;
    stripePendingPence = providerBalance.pending_pence;
    stripeBalanceError = providerBalance.error;

    const stripeCash = partitionStripePlatformCash({
      stripeAvailablePence,
      driverPayoutLiabilityPence: availablePayout,
      pendingTransfersPence: pendingTransfers,
    });

    const settlementStatus: OnecabSettlementStatus = classifyOnecabSettlementStatus({
      calculatedOnecabNetPence: finance.onecab_net_pence,
      verifiedOnecabNetPence: finance.verified_onecab_net_pence,
      stripeAvailablePence,
      stripePendingPence,
      verifiedTripCount: finance.verified_trip_count,
      tripCount: finance.tripCount,
    });

    const reconciliation = reconcileStripeBalance({
      stripeAvailablePence,
      calculatedOnecabNetPence: finance.onecab_net_pence,
      availableDriverPayablePence: availablePayout,
      pendingTransfersPence: pendingTransfers,
    });

    const latestFailure = scopedFailed[0] ?? null;
    const latestRequested = Number(latestFailure?.amount_pence || 0);
    const diagnoses = latestFailure
      ? buildInsufficientFundsDiagnosis({
        failureReason: latestFailure.error_message,
        requestedPayoutPence: latestRequested,
        stripeAvailablePence,
        stripePendingPence,
        calculatedOnecabNetPence: finance.onecab_net_pence,
        driverPendingSettlementPence: pendingTransfers,
      })
      : [];

    const safePayout = computeSafePayoutAmount({
      driverAvailablePence: availablePayout,
      stripeAvailablePence,
    });

    return new Response(JSON.stringify({
      period: { from: periodFrom, to: periodTo },
      currency_code: currency.toUpperCase(),
      accounting_rules: {
        onecab_gross_commission: "sum(trips.commission_pence) — 15% includes Stripe fee",
        onecab_net: "onecab_gross_commission_pence - stripe_fee_pence",
        not_commission: [
          "Stripe available platform balance",
          "Captured card revenue / customer revenue",
          "Driver payable / wallet balance",
          "Stripe balance minus driver payable",
        ],
      },
      customer_revenue_summary: {
        total_customer_revenue_pence: finance.total_customer_revenue_pence,
        total_commissionable_revenue_pence: finance.total_commissionable_revenue_pence,
        trip_count: finance.tripCount,
      },
      driver_earnings_summary: {
        driver_gross_earnings_pence: finance.driver_gross_earnings_pence,
        driver_net_earnings_pence: finance.driver_net_earnings_pence,
      },
      onecab_commission_summary: {
        onecab_gross_commission_pence: finance.onecab_gross_commission_pence,
        stripe_fee_pence: finance.stripe_fee_pence,
        onecab_net_pence: finance.onecab_net_pence,
        max_commission_at_15_percent_pence: finance.max_commission_at_15_percent_pence,
        commission_exceeds_cap: finance.commission_exceeds_15_percent_cap,
        verified_onecab_net_pence: finance.verified_onecab_net_pence,
        pending_stripe_settlement_pence: stripePendingPence,
        settlement_status: settlementStatus,
        settlement_status_label: settlementStatusLabel(settlementStatus),
        driver_payout_liability_pence: availablePayout,
      },
      stripe_platform_summary: {
        available_platform_balance_pence: stripeAvailablePence,
        pending_platform_balance_pence: stripePendingPence,
        unallocated_platform_cash_pence: stripeCash.unallocated_platform_cash_pence,
        error: stripeBalanceError,
        note: "Platform balance is total Stripe cash — NOT ONECAB commission",
      },
      driver_payout_summary: {
        wallet_balance_pence: walletBalance,
        available_payout_pence: availablePayout,
        pending_payout_pence: pendingTransfers,
        paid_out_pence: paidOut,
        failed_amount_today_pence: failedAmount,
        failure_reasons: Array.from(failureReasonMap.entries()).map(([reason, v]) => ({
          reason,
          amount_pence: v.amount_pence,
          count: v.count,
        })),
        safe_payout_amount_pence: safePayout.payout_amount_pence,
        partial_payout_recommended: safePayout.partial,
        waiting_for_stripe_funds: safePayout.waiting_for_stripe_funds,
      },
      reconciliation,
      insufficient_funds_insight: latestFailure
        ? {
          reason: parseInsufficientFundsReason(latestFailure.error_message) ||
            latestFailure.error_message,
          requested_driver_payout_pence: latestRequested,
          stripe_available_balance_at_review_pence: stripeAvailablePence,
          stripe_pending_balance_at_review_pence: stripePendingPence,
          calculated_onecab_net_pence: finance.onecab_net_pence,
          driver_funds_pending_settlement_pence: pendingTransfers,
          diagnoses,
          why_commission_showed_but_payout_failed: diagnoses,
        }
        : null,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[admin-finance-settlement-summary]", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function settlementStatusLabel(status: OnecabSettlementStatus): string {
  switch (status) {
    case "calculated_only":
      return "Calculated only — not confirmed in Stripe";
    case "pending_stripe_settlement":
      return "Pending Stripe settlement";
    case "available_in_stripe_balance":
      return "ONECAB net available in Stripe (trip-verified)";
    case "paid_to_onecab_bank":
      return "Paid out to ONECAB bank";
    case "reconciled":
      return "Reconciled";
    default:
      return status;
  }
}
