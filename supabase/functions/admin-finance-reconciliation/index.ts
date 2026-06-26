import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { computeSSOTMetrics } from "../_shared/financialReconciliationSSOT.ts";
import { fetchPerDriverFinancialReconciliation } from "../_shared/perDriverFinancialReconciliation.ts";
import {
  buildFinanceReconciliationSummary,
  classifyOnecabSettlementStatus,
  COUNTABLE_FINANCIAL_OUTCOMES,
  buildTripFinancialAuditContext,
  mapTripToFinancialAuditRow,
  sumCommissionableFromTrips,
  sumTripFinanceMetrics,
  type TripAuditSourceRow,
} from "../_shared/financeSettlementSummary.ts";
import {
  isTripUuid,
  NO_MATCH_TRIP_ID,
  tripCodeOrFilter,
} from "../_shared/tripAdminSearch.ts";

const TRIP_AUDIT_SELECT = `
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
        outstanding_balance_pence,
        payment_coverage_status,
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
        stripe_payment_intent_id,
        stripe_charge_id,
        provider_status,
        driver_id,
        stripe_settlement_verified,
        stripe_settlement_warning,
        refunded_at,
        driver_tier_commission_percent,
        commission_pct,
        completed_at,
        service_area_id,
        driver:drivers!trips_driver_id_fkey(first_name, last_name)
      `;

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

const MAX_LEDGER_DRIVER_IN = 150;

async function fetchLedgerRowsForPeriod(
  supabase: ReturnType<typeof createClient>,
  periodFrom: string,
  periodTo: string,
  driverIds: string[],
): Promise<Array<{ type: string; amount_pence: number; driver_id: string; related_trip_id: string | null }>> {
  const base = () =>
    supabase
      .from("driver_wallet_ledger")
      .select("type, amount_pence, driver_id, related_trip_id")
      .gte("created_at", periodFrom)
      .lte("created_at", periodTo);

  if (driverIds.length === 0) {
    return [];
  }

  if (driverIds.length <= MAX_LEDGER_DRIVER_IN) {
    const { data, error } = await base().in("driver_id", driverIds);
    if (error) throw error;
    return data ?? [];
  }

  const rows: Array<{ type: string; amount_pence: number; driver_id: string; related_trip_id: string | null }> = [];
  for (let i = 0; i < driverIds.length; i += MAX_LEDGER_DRIVER_IN) {
    const chunk = driverIds.slice(i, i + MAX_LEDGER_DRIVER_IN);
    const { data, error } = await base().in("driver_id", chunk);
    if (error) throw error;
    rows.push(...(data ?? []));
  }
  return rows;
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
    const search = url.searchParams.get("search");
    const searchType = url.searchParams.get("search_type");
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
      .select(TRIP_AUDIT_SELECT)
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

    const financialRows = financialResult.data ?? [];
    const driverIds = financialRows.map((d) => d.driver_id);

    const [
      tripResult,
      ledgerRows,
      pendingPayoutsResult,
      pendingCashoutsResult,
      webhookResult,
      failedWebhooksResult,
    ] = await Promise.all([
      tripQuery,
      fetchLedgerRowsForPeriod(supabase, periodFrom, periodTo, driverIds),
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

    const tripRows = (tripResult.data || []) as TripAuditSourceRow[];
    const finance = sumTripFinanceMetrics(tripRows);
    const commissionableRevenue = sumCommissionableFromTrips(tripRows);

    const tripIds = tripRows.map((t) => t.id);
    let paymentRows: Array<{
      captured_amount_pence: number | null;
      status: string | null;
      trip_id: string | null;
      provider_status: string | null;
      stripe_payment_intent_id: string | null;
      provider_available_on: string | null;
    }> = [];
    let auditPayoutItems: Array<{
      trip_id: string | null;
      status: string;
      driver_amount_pence?: number | null;
      amount_pence?: number | null;
      batch_id?: string | null;
    }> = [];
    let auditLedgerRows: Array<{
      related_trip_id: string | null;
      type: string;
      amount_pence: number;
      stripe_payout_id?: string | null;
      stripe_transfer_id?: string | null;
    }> = [];

    if (tripIds.length > 0) {
      const [paymentsRes, payoutItemsRes, tripLedgerRes] = await Promise.all([
        supabase
          .from("payments")
          .select("captured_amount_pence, status, trip_id, provider_status, stripe_payment_intent_id, provider_available_on")
          .in("trip_id", tripIds),
        supabase
          .from("payout_items")
          .select("trip_id, status, driver_amount_pence, amount_pence, batch_id")
          .in("trip_id", tripIds),
        supabase
          .from("driver_wallet_ledger")
          .select("related_trip_id, type, amount_pence, stripe_payout_id, stripe_transfer_id")
          .in("related_trip_id", tripIds),
      ]);
      if (paymentsRes.error) throw paymentsRes.error;
      if (payoutItemsRes.error) throw payoutItemsRes.error;
      if (tripLedgerRes.error) throw tripLedgerRes.error;
      paymentRows = paymentsRes.data || [];
      auditPayoutItems = payoutItemsRes.data || [];
      auditLedgerRows = (tripLedgerRes.data || []).map((row) => ({
        related_trip_id: row.related_trip_id ?? null,
        type: row.type,
        amount_pence: row.amount_pence,
        stripe_payout_id: row.stripe_payout_id ?? null,
        stripe_transfer_id: row.stripe_transfer_id ?? null,
      }));
    }

    const auditContext = buildTripFinancialAuditContext({
      payments: paymentRows,
      payoutItems: auditPayoutItems,
      ledgerRows: auditLedgerRows,
    });

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
        const avail = balance.available.find((b: { currency: string }) => b.currency === currency);
        const pend = balance.pending.find((b: { currency: string }) => b.currency === currency);
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
      ledger: ledgerRows,
      providerAvailableBalancePence: stripeAvailablePence,
      providerPendingBalancePence: stripePendingPence,
    });

    const settlementStatus = classifyOnecabSettlementStatus({
      calculatedOnecabNetPence: ssotMetrics.onecab_card_net_commission_pence,
      verifiedOnecabNetPence: finance.verified_onecab_net_pence,
      stripeAvailablePence,
      stripePendingPence,
      verifiedTripCount: finance.verified_trip_count,
      tripCount: finance.tripCount,
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
      onecabBankPayoutPence: settlementStatus === "paid_to_onecab_bank" ? ssotMetrics.net_platform_revenue_pence : 0,
      dataSourceBadge: "LIVE",
    });

    const trip_financial_audit = search?.trim()
      ? await (async () => {
        let auditSearchQuery = supabase
          .from("trips")
          .select(TRIP_AUDIT_SELECT)
          .or(`financial_outcome.in.(${COUNTABLE_FINANCIAL_OUTCOMES.join(",")}),status.in.(completed,no_show)`)
          .not("completed_at", "is", null)
          .order("completed_at", { ascending: false })
          .limit(Math.min(auditLimit, 50));

        if (serviceAreaId) {
          auditSearchQuery = auditSearchQuery.eq("service_area_id", serviceAreaId);
        } else if (resolvedRegionId) {
          const { data: areas } = await supabase.from("service_areas").select("id").eq("region_id", resolvedRegionId);
          const ids = (areas || []).map((a) => a.id);
          if (ids.length === 0) return [];
          auditSearchQuery = auditSearchQuery.in("service_area_id", ids);
        }

        const term = search.trim();
        if (searchType === "id") {
          auditSearchQuery = isTripUuid(term)
            ? auditSearchQuery.eq("id", term.toLowerCase())
            : auditSearchQuery.eq("id", NO_MATCH_TRIP_ID);
        } else if (isTripUuid(term)) {
          auditSearchQuery = auditSearchQuery.eq("id", term.toLowerCase());
        } else {
          auditSearchQuery = auditSearchQuery.or(tripCodeOrFilter(term));
        }

        const { data: searchTrips, error: searchError } = await auditSearchQuery;
        if (searchError) throw searchError;

        const auditSourceRows = (searchTrips || []) as TripAuditSourceRow[];
        const auditTripIds = auditSourceRows.map((t) => t.id);
        if (auditTripIds.length === 0) return [];

        const [paymentsRes, payoutItemsRes, tripLedgerRes] = await Promise.all([
          supabase
            .from("payments")
            .select("captured_amount_pence, status, trip_id, provider_status, stripe_payment_intent_id, provider_available_on")
            .in("trip_id", auditTripIds),
          supabase
            .from("payout_items")
            .select("trip_id, status, driver_amount_pence, amount_pence, batch_id")
            .in("trip_id", auditTripIds),
          supabase
            .from("driver_wallet_ledger")
            .select("related_trip_id, type, amount_pence, stripe_payout_id, stripe_transfer_id")
            .in("related_trip_id", auditTripIds),
        ]);
        if (paymentsRes.error) throw paymentsRes.error;
        if (payoutItemsRes.error) throw payoutItemsRes.error;
        if (tripLedgerRes.error) throw tripLedgerRes.error;

        const searchAuditContext = buildTripFinancialAuditContext({
          payments: paymentsRes.data || [],
          payoutItems: payoutItemsRes.data || [],
          ledgerRows: (tripLedgerRes.data || []).map((row) => ({
            related_trip_id: row.related_trip_id ?? null,
            type: row.type,
            amount_pence: row.amount_pence,
            stripe_payout_id: row.stripe_payout_id ?? null,
            stripe_transfer_id: row.stripe_transfer_id ?? null,
          })),
        });

        return auditSourceRows.map((row) => mapTripToFinancialAuditRow(row, searchAuditContext));
      })()
      : tripRows.map((row) => mapTripToFinancialAuditRow(row, auditContext));

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
          card_customer_revenue: "sum(card trip fare + card tips) from payments/trips — card trips only",
          cash_collected_by_driver: "sum(cash trip fare) — not ONECAB Stripe revenue",
          onecab_card_commission: "sum(card trip commission_pence)",
          onecab_cash_commission_receivable: "sum(cash trip commission_pence) — owed by driver",
          onecab_card_net_commission: "onecab_card_commission - stripe_processing_fees (card trips only)",
          total_commission_earned: "onecab_card_commission + onecab_cash_commission_receivable",
          net_platform_revenue: "total_commission_earned - stripe_processing_fees (card only; cash fee = 0)",
          cash_stripe_fees: "always 0 — cash trips have no Stripe processing fee",
          driver_payout_liability: "card_driver_payable - driver_paid_out + adjustments (excludes cash driver_net)",
          driver_wallet: "card: +driver_net+tips; cash: -commission (fare already with driver)",
          card_reconciliation:
            "card_customer_revenue = card_driver_payable + onecab_card_commission",
          cash_reconciliation:
            "cash_collected_by_driver = cash_driver_already_received + onecab_cash_commission_receivable",
        },
      },
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[admin-finance-reconciliation]", error);
    const message = error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
      ? String((error as { message: unknown }).message)
      : "Finance reconciliation query failed";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
