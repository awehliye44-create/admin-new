import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { computeSSOTMetrics, SSOT_VERSION } from "../_shared/financialReconciliationSSOT.ts";
import { fetchConnectMoneyMovementBundle } from "../_shared/connectMoneyMovementSSOT.ts";
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
import { getLondonDayBounds } from "../_shared/financeLondonDay.ts";
import { fetchRegionPlatformKpis } from "../_shared/platformReconciliationKpis.ts";
import { buildDriverStatementPeriodTotals } from "../_shared/driverStatementPeriodTotals.ts";

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
        status,
        financial_outcome,
        stripe_payment_intent_id,
        stripe_charge_id,
        provider_status,
        driver_id,
        passenger_name,
        stripe_settlement_verified,
        stripe_settlement_warning,
        refunded_at,
        driver_tier_commission_percent,
        commission_pct,
        completed_at,
        service_area_id,
        driver:drivers!trips_driver_id_fkey(first_name, last_name)
      `;

function buildStripePaymentIntentAuditRows(
  tripRows: TripAuditSourceRow[],
  paymentRows: Array<{
    captured_amount_pence: number | null;
    status: string | null;
    trip_id: string | null;
    provider_status: string | null;
    stripe_payment_intent_id: string | null;
  }>,
) {
  const tripById = new Map(tripRows.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const rows: Array<{
    payment_intent_id: string;
    trip_id: string | null;
    trip_code: string | null;
    driver_id: string | null;
    customer_name: string | null;
    driver_name: string | null;
    captured_pence: number;
    status: string;
    date: string | null;
  }> = [];

  for (const payment of paymentRows) {
    const pi = payment.stripe_payment_intent_id?.trim();
    if (!pi || seen.has(pi)) continue;
    seen.add(pi);
    const trip = payment.trip_id ? tripById.get(payment.trip_id) ?? null : null;
    const driverName = trip?.driver
      ? [trip.driver.first_name, trip.driver.last_name].filter(Boolean).join(" ").trim() || null
      : null;
    rows.push({
      payment_intent_id: pi,
      trip_id: payment.trip_id,
      trip_code: trip?.trip_code ?? null,
      driver_id: trip?.driver_id ?? null,
      customer_name: trip?.passenger_name?.trim() || null,
      driver_name: driverName,
      captured_pence: Math.max(0, Number(payment.captured_amount_pence ?? 0)),
      status: payment.provider_status ?? payment.status ?? "unknown",
      date: trip?.completed_at ?? null,
    });
  }

  rows.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  return rows;
}

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

// Hard cap on any single Stripe-heavy sub-call so the whole edge function
// stays under the 150s idle-timeout limit even on large Connect accounts.
const STRIPE_SECTION_TIMEOUT_MS = 25_000;

async function withTimeout<T>(
  label: string,
  ms: number,
  promise: Promise<T>,
): Promise<T | { __timeout: true; label: string }> {
  return await Promise.race<T | { __timeout: true; label: string }>([
    promise,
    new Promise((resolve) =>
      setTimeout(() => resolve({ __timeout: true, label }), ms)
    ),
  ]);
}


async function fetchLegacyManualReviewItems(
  supabase: ReturnType<typeof createClient>,
): Promise<Array<{
  payout_item_id: string;
  driver_id: string;
  amount_pence: number;
  completed_at: string | null;
  manual_review_reason: string | null;
  excluded_from_auto_allocation: boolean;
}>> {
  const { data, error } = await supabase
    .from("payout_items")
    .select("id, driver_id, amount_pence, driver_amount_pence, completed_at, manual_review_reason, excluded_from_auto_allocation")
    .or("manual_review_required.eq.true,excluded_from_auto_allocation.eq.true")
    .in("status", ["completed", "COMPLETED", "SENT", "PAID", "paid"])
    .order("completed_at", { ascending: false });

  if (error) {
    console.warn("[admin-finance-reconciliation] legacy manual review fetch failed:", error.message);
    return [];
  }

  return (data ?? []).map((row) => ({
    payout_item_id: row.id as string,
    driver_id: row.driver_id as string,
    amount_pence: Math.abs(Number(row.driver_amount_pence ?? row.amount_pence ?? 0)),
    completed_at: (row.completed_at as string | null) ?? null,
    manual_review_reason: (row.manual_review_reason as string | null) ?? null,
    excluded_from_auto_allocation: row.excluded_from_auto_allocation === true,
  }));
}

async function fetchWebhookHealth(
  supabase: ReturnType<typeof createClient>,
): Promise<{ lastWebhookAt: string | null; failedWebhookCount: number }> {
  try {
    const [webhookResult, failedWebhooksResult] = await Promise.all([
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
    if (webhookResult.error || failedWebhooksResult.error) {
      return { lastWebhookAt: null, failedWebhookCount: 0 };
    }
    return {
      lastWebhookAt: webhookResult.data?.created_at ?? null,
      failedWebhookCount: failedWebhooksResult.count ?? 0,
    };
  } catch {
    return { lastWebhookAt: null, failedWebhookCount: 0 };
  }
}

function safeMapTripAuditRow(
  row: TripAuditSourceRow,
  context: ReturnType<typeof buildTripFinancialAuditContext>,
): ReturnType<typeof mapTripToFinancialAuditRow> | null {
  try {
    return mapTripToFinancialAuditRow(row, context);
  } catch (e) {
    console.warn("[admin-finance-reconciliation] Skipping audit row", row.id, e);
    return null;
  }
}

async function fetchLedgerRowsForPeriod(
  supabase: ReturnType<typeof createClient>,
  periodFrom: string,
  periodTo: string,
  driverIds: string[],
  currencyCode?: string | null,
): Promise<Array<{ type: string; amount_pence: number; driver_id: string; related_trip_id: string | null }>> {
  const base = () => {
    let q = supabase
      .from("driver_wallet_ledger")
      .select("type, amount_pence, driver_id, related_trip_id")
      .gte("created_at", periodFrom)
      .lte("created_at", periodTo);
    if (currencyCode) {
      q = q.eq("currency", currencyCode.toUpperCase());
    }
    return q;
  };

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
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    const { data: roleData } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();

    let isAuthorized = !!roleData;
    if (!isAuthorized) {
      const { data: staffRow } = await supabase
        .from("staff_profiles")
        .select("id")
        .eq("user_id", userId)
        .eq("is_active", true)
        .maybeSingle();
      isAuthorized = !!staffRow;
    }

    if (!isAuthorized) {
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
    const summaryOnly =
      url.searchParams.get("summary_only") === "1"
      || url.searchParams.get("summary_only") === "true";
    const statementTotalsOnly = url.searchParams.get("statement_totals") === "1";
    const profitSsotOnly = url.searchParams.get("profit_ssot") === "1";
    const statementDriverIds = (url.searchParams.get("driver_ids") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const auditLimit = statementTotalsOnly
      ? Math.min(Number(url.searchParams.get("audit_limit") || 10000), 10000)
      : profitSsotOnly || summaryOnly
      ? Math.min(Number(url.searchParams.get("audit_limit") || 500), 2000)
      : Math.min(Number(url.searchParams.get("audit_limit") || 100), 500);

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
      webhookHealth,
      legacyManualReviewItems,
    ] = await Promise.all([
      tripQuery,
      fetchLedgerRowsForPeriod(
        supabase,
        periodFrom,
        periodTo,
        statementTotalsOnly && statementDriverIds.length > 0 ? statementDriverIds : driverIds,
        statementTotalsOnly ? currency.toUpperCase() : null,
      ),
      supabase.from("payout_items").select("amount_pence").in("status", ["pending", "processing"]),
      supabase
        .from("driver_early_cashouts")
        .select("requested_cashout_pence, driver_receives_pence")
        .in("status", ["processing", "pending", "transfer_created"]),
      fetchWebhookHealth(supabase),
      fetchLegacyManualReviewItems(supabase),
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

    if (tripIds.length > 0 && !summaryOnly) {
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
    } else if (tripIds.length > 0 && summaryOnly) {
      const paymentsRes = await supabase
        .from("payments")
        .select("captured_amount_pence, status, trip_id, provider_status, stripe_payment_intent_id, provider_available_on")
        .in("trip_id", tripIds);
      if (paymentsRes.error) throw paymentsRes.error;
      paymentRows = paymentsRes.data || [];
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
    let moneyMovement = undefined;

    if (stripeSecretKey) {
      try {
        const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });
        const balance = await stripe.balance.retrieve();
        const avail = balance.available.find((b: { currency: string }) => b.currency === currency);
        const pend = balance.pending.find((b: { currency: string }) => b.currency === currency);
        stripeAvailablePence = avail?.amount ?? 0;
        stripePendingPence = pend?.amount ?? 0;

        if (!summaryOnly) {
          const mm = await withTimeout(
            "connect_money_movement",
            STRIPE_SECTION_TIMEOUT_MS,
            fetchConnectMoneyMovementBundle({
              supabase,
              stripe,
              currency,
              regionId: resolvedRegionId,
              serviceAreaId: serviceAreaId ?? null,
              periodFrom,
              periodTo,
            }),
          );
          if (mm && typeof mm === "object" && "__timeout" in mm) {
            stripeBalanceError = "connect_money_movement_timeout";
            moneyMovement = undefined;
          } else {
            moneyMovement = mm;
          }
        }
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

    const { failedWebhookCount, lastWebhookAt } = webhookHealth;
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
      moneyMovement,
    });

    const trip_financial_audit = summaryOnly
      ? []
      : search?.trim()
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

        return auditSourceRows
          .map((row) => safeMapTripAuditRow(row, searchAuditContext))
          .filter((row): row is NonNullable<typeof row> => row !== null);
      })()
      : tripRows
        .map((row) => safeMapTripAuditRow(row, auditContext))
        .filter((row): row is NonNullable<typeof row> => row !== null);

    if (statementTotalsOnly) {
      const driverIdSet = statementDriverIds.length > 0 ? new Set(statementDriverIds) : undefined;
      const driver_statement_totals = buildDriverStatementPeriodTotals(
        trip_financial_audit,
        ledgerRows,
        driverIdSet,
      );
      return new Response(JSON.stringify({
        period: { from: periodFrom, to: periodTo },
        currency_code: currency.toUpperCase(),
        driver_statement_totals,
        meta: {
          audit_row_count: trip_financial_audit.length,
          driver_count: driver_statement_totals.length,
          ssot_version: SSOT_VERSION,
          data_source_badge: "LIVE",
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const stripe_payment_intents = buildStripePaymentIntentAuditRows(tripRows, paymentRows);

    let platform_kpis = null;
    if (!summaryOnly && !driverId) {
      const { start: londonStart, end: londonEnd } = getLondonDayBounds();
      let todayTripQuery = supabase
        .from("trips")
        .select("id, completed_at, payment_method")
        .gte("completed_at", londonStart.toISOString())
        .lte("completed_at", londonEnd.toISOString())
        .not("completed_at", "is", null)
        .or(`financial_outcome.in.(${COUNTABLE_FINANCIAL_OUTCOMES.join(",")}),status.in.(completed,no_show)`);

      if (serviceAreaId) todayTripQuery = todayTripQuery.eq("service_area_id", serviceAreaId);
      else if (resolvedRegionId) {
        const { data: areas } = await supabase.from("service_areas").select("id").eq("region_id", resolvedRegionId);
        const ids = (areas || []).map((a) => a.id);
        if (ids.length > 0) todayTripQuery = todayTripQuery.in("service_area_id", ids);
      }

      const { data: todayTrips, error: todayTripsErr } = await todayTripQuery;
      if (todayTripsErr) throw todayTripsErr;
      const todayTripIds = (todayTrips ?? []).map((t) => t.id as string);
      let todayPayments: Array<{ trip_id: string | null; captured_amount_pence: number | null; status: string | null }> = [];
      if (todayTripIds.length > 0) {
        const { data: payData } = await supabase
          .from("payments")
          .select("trip_id, captured_amount_pence, status")
          .in("trip_id", todayTripIds);
        todayPayments = payData ?? [];
      }
      const capturedByTrip = new Map<string, number>();
      for (const p of todayPayments) {
        if (!p.trip_id) continue;
        const cap = Math.max(0, Number(p.captured_amount_pence ?? 0));
        capturedByTrip.set(p.trip_id, (capturedByTrip.get(p.trip_id) ?? 0) + cap);
      }

      const todayAuditRows = (todayTrips ?? []).map((t) => ({
        date: t.completed_at as string | null,
        payment_method: t.payment_method as string | null,
        captured_pence: capturedByTrip.get(t.id as string) ?? 0,
      }));

      const stripeClient = stripeSecretKey
        ? new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" })
        : null;
      const kpisResult = await withTimeout(
        "platform_kpis",
        STRIPE_SECTION_TIMEOUT_MS,
        fetchRegionPlatformKpis(supabase, {
          regionId: resolvedRegionId,
          stripe: stripeClient,
          todayAuditRows,
        }),
      );
      platform_kpis =
        kpisResult && typeof kpisResult === "object" && "__timeout" in kpisResult
          ? null
          : kpisResult;
    }

    if (profitSsotOnly) {
      const net = finance_reconciliation_summary.onecab_money.onecab_net_commission_pence;
      const fromDate = periodFrom.slice(0, 10);
      const toDate = periodTo.slice(0, 10);
      let expQuery = supabase
        .from("onecab_expenses")
        .select("amount_pence")
        .gte("expense_date", fromDate)
        .lte("expense_date", toDate);
      if (resolvedRegionId) {
        expQuery = expQuery.eq("region_id", resolvedRegionId);
      }
      const { data: expenseRows, error: expErr } = await expQuery;
      if (expErr) throw expErr;
      const expenses_pence = (expenseRows ?? []).reduce(
        (s, row) => s + Number(row.amount_pence ?? 0),
        0,
      );
      const profit_before_tax_pence = net == null ? null : net - expenses_pence;
      return new Response(JSON.stringify({
        period: { from: periodFrom, to: periodTo },
        currency_code: currency.toUpperCase(),
        profit_ssot: {
          platform_net_revenue_pence: net,
          expenses_pence,
          profit_before_tax_pence,
        },
        meta: {
          ssot_version: SSOT_VERSION,
          data_source_badge: "LIVE",
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      period: { from: periodFrom, to: periodTo },
      currency_code: currency.toUpperCase(),
      finance_reconciliation_summary,
      platform_kpis,
      trip_financial_audit,
      stripe_payment_intents,
      legacy_manual_review_items: legacyManualReviewItems,
      money_movement: moneyMovement,
      meta: {
        trip_count: finance.tripCount,
        audit_row_count: trip_financial_audit.length,
        stripe_balance_error: stripeBalanceError,
        ssot_version: SSOT_VERSION,
        data_source_badge: "LIVE",
        accounting_rules: {
          card_customer_revenue: "sum(captured_amount_pence) where payments.status in captured|paid|succeeded — card only",
          pending_stripe_confirmation: "completed card trips without capture confirmation — excluded from reconciled totals",
          cash_collected_by_driver: "sum(cash trip fare) — not ONECAB Stripe revenue",
          onecab_card_commission: "sum(card trip commission_pence) capture-confirmed only, refund-adjusted",
          onecab_cash_commission_receivable: "sum(cash trip commission_pence) — owed by driver",
          onecab_card_net_commission: "onecab_card_commission - stripe_processing_fees (card trips only)",
          total_commission_earned: "onecab_card_commission + onecab_cash_commission_receivable",
          net_platform_revenue: "total_commission_earned - stripe_processing_fees (card only; cash fee = 0)",
          cash_stripe_fees: "always 0 — cash trips have no Stripe processing fee",
          driver_payout_liability: "card_driver_payable - driver_paid_out + adjustments (excludes cash driver_net)",
          driver_wallet: "card: +driver_net+tips; cash: -commission (fare already with driver)",
          stripe_payout_confirmation: "driver bank receipt requires Stripe Connect payout paid + ledger stripe_payout_id",
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
