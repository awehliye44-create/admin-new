import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { computeSSOTMetrics, mergePaymentSessionsIntoCaptureRows, sumCapturedPaymentsByTripId, SSOT_VERSION, type PaymentSessionMoneyRow } from "../_shared/financialReconciliationSSOT.ts";
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
import { getLondonDayBounds, normalizeFinancePeriodParam } from "../_shared/financeLondonDay.ts";
import { fetchRegionPlatformKpis } from "../_shared/platformReconciliationKpis.ts";
import { buildDriverStatementPeriodTotals } from "../_shared/driverStatementPeriodTotals.ts";
import {
  buildCurrencyGroupsFromTrips,
  resolveFinanceCurrencyScope,
} from "../_shared/financeCurrencySSOT.ts";
import { resolveAllServiceAreaGatewayStatuses } from "../_shared/paymentGatewayStatus.ts";
import {
  fetchProviderPlatformBalance,
  resolveFinanceScopeProvider,
} from "../_shared/providerPlatformBalanceSSOT.ts";
import { computeLedgerWalletBalancePence } from "../_shared/onecabFinanceLedger.ts";
import {
  buildFrAuditOverviewKpis,
  buildFrCustomerMoneyKpisFromPaymentSessions,
} from "../_shared/frTripAuditComparisonSSOT.ts";
import {
  applyFinanceReconciliationTripLocationFilter,
  buildFinanceReconciliationTripQuery,
  resolveFinanceReconciliationAuditLimit,
} from "../_shared/financeReconciliationTripQuery.ts";

const PAYMENT_SESSION_MONEY_SELECT =
  "id, trip_id, status, payment_method, captured_amount_pence, authorised_amount_pence, total_authorised_amount_pence, released_amount_pence, refunded_amount_pence, provider_processing_fee_pence, fee_status, provider_state, provider_state_verified_at, release_evidence_status, release_evidence_source, release_verified_at, metadata";

const TRIP_AUDIT_SELECT = `
        id,
        trip_code,
        commission_pence,
        stripe_processing_fee_pence,
        provider_fee_pence,
        onecab_net_pence,
        driver_net_pence,
        gross_fare_pence,
        final_fare_pence,
        final_customer_fare_pence,
        commissionable_fare_pence,
        capture_amount_pence,
        outstanding_balance_pence,
        payment_coverage_status,
        refund_amount_pence,
        pickup_waiting_charge_pence,
        stop_waiting_charge_pence,
        stop_charge_total_pence,
        total_waiting_charge_pence,
        no_show_charge_pence,
        customer_modification_charge_pence,
        destination_change_adjustment_pence,
        extras_pence,
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
        created_at,
        service_area_id,
        region_id,
        financial_model,
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
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function startOfTodayUtc(): string {
  return getLondonDayBounds().start.toISOString();
}

function endOfTodayUtc(): string {
  return getLondonDayBounds().end.toISOString();
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
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const [lastResult, failedWebhooksResult] = await Promise.all([
      supabase
        .from("processed_stripe_events")
        .select("processed_at")
        .order("processed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("processed_stripe_events")
        .select("id", { count: "exact", head: true })
        .in("status", ["failed_retry", "failed_non_retry"])
        .gte("processed_at", since24h),
    ]);
    if (lastResult.error || failedWebhooksResult.error) {
      return { lastWebhookAt: null, failedWebhookCount: 0 };
    }
    return {
      lastWebhookAt: lastResult.data?.processed_at ?? null,
      failedWebhookCount: failedWebhooksResult.count ?? 0,
    };
  } catch {
    return { lastWebhookAt: null, failedWebhookCount: 0 };
  }
}

function computeProviderHealthStatus(args: {
  stripeBalanceError: string | null;
  stripeSecretConfigured: boolean;
  connectBundleExpected: boolean;
  connectBundleLoaded: boolean;
  failedWebhookCount: number;
}): "healthy" | "degraded" | "failing" {
  if (!args.stripeSecretConfigured) return "failing";
  if (args.stripeBalanceError) {
    return args.stripeBalanceError === "connect_money_movement_timeout" ? "degraded" : "failing";
  }
  if (args.failedWebhookCount > 0) return "degraded";
  if (args.connectBundleExpected && !args.connectBundleLoaded) return "degraded";
  return "healthy";
}

async function buildServiceAreaCurrencyMap(
  supabase: ReturnType<typeof createClient>,
  tripRows: TripAuditSourceRow[],
): Promise<Map<string, string>> {
  const serviceAreaIds = [...new Set(
    tripRows.map((t) => t.service_area_id).filter((id): id is string => Boolean(id)),
  )];
  if (serviceAreaIds.length === 0) return new Map();

  const { data: serviceAreas } = await supabase
    .from("service_areas")
    .select("id, region_id")
    .in("id", serviceAreaIds);
  const regionIds = [...new Set(
    (serviceAreas ?? []).map((sa) => sa.region_id).filter((id): id is string => Boolean(id)),
  )];
  if (regionIds.length === 0) return new Map();

  const { data: regions } = await supabase
    .from("regions")
    .select("id, currency_code")
    .in("id", regionIds);
  const regionCurrency = new Map(
    (regions ?? []).map((r) => [r.id, String(r.currency_code).toUpperCase()]),
  );

  return new Map(
    (serviceAreas ?? []).map((sa) => [
      sa.id,
      regionCurrency.get(sa.region_id) ?? "GBP",
    ]),
  );
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
    let staffRole: string | null = null;
    if (!isAuthorized) {
      const { data: staffRow } = await supabase
        .from("staff_profiles")
        .select("id, role")
        .eq("user_id", userId)
        .eq("is_active", true)
        .maybeSingle();
      isAuthorized = !!staffRow;
      staffRole = (staffRow?.role as string | null) ?? null;
    }

    if (!isAuthorized) {
      return new Response(JSON.stringify({
        success: false,
        error: "You do not have Financial Reconciliation permission",
        required_permission: "financial-reconciliation",
      }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Super admin / platform admin always allowed; other staff need page slug.
    const elevated = staffRole === "super_admin"
      || staffRole === "admin"
      || staffRole === "finance_manager"
      || !!roleData;
    if (!elevated) {
      const { data: pagePerm } = await supabase
        .from("role_page_permissions")
        .select("can_access")
        .eq("role", staffRole)
        .eq("page_slug", "financial-reconciliation")
        .eq("can_access", true)
        .maybeSingle();
      if (!pagePerm) {
        return new Response(JSON.stringify({
          success: false,
          error: "You do not have Financial Reconciliation permission",
          required_permission: "financial-reconciliation",
        }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const url = new URL(req.url);
    const regionId = url.searchParams.get("region_id") || req.headers.get("x-region-id");
    const serviceAreaId = url.searchParams.get("service_area_id") || req.headers.get("x-service-area-id");
    const periodFrom =
      normalizeFinancePeriodParam(url.searchParams.get("from") ?? url.searchParams.get("date_from"), "start")
      || startOfTodayUtc();
    const periodTo =
      normalizeFinancePeriodParam(url.searchParams.get("to") ?? url.searchParams.get("date_to"), "end")
      || endOfTodayUtc();
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
    const auditLimit = resolveFinanceReconciliationAuditLimit(
      url.searchParams.get("audit_limit"),
      statementTotalsOnly ? "statement" : profitSsotOnly || summaryOnly ? "summary" : "full",
    );

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

    const financeScopeProvider = await resolveFinanceScopeProvider(supabase, {
      regionId: resolvedRegionId ?? null,
      serviceAreaId: serviceAreaId ?? null,
    });

    let tripQuery = buildFinanceReconciliationTripQuery(supabase, {
      periodFrom,
      periodTo,
      auditLimit,
      select: TRIP_AUDIT_SELECT,
    });

    tripQuery = await applyFinanceReconciliationTripLocationFilter(
      tripQuery,
      supabase,
      { regionId: resolvedRegionId, serviceAreaId },
    );

    const financialPromise = resolvedRegionId
      ? supabase
        .from("driver_financial_summary")
        .select("driver_id, wallet_balance, available_for_payout, net_available_for_payout, total_payouts_sent, reserved_cashout_pence, region_id")
        .eq("region_id", resolvedRegionId)
      : supabase
        .from("driver_financial_summary")
        .select("driver_id, wallet_balance, available_for_payout, net_available_for_payout, total_payouts_sent, reserved_cashout_pence, region_id");

    let walletDownstream: "OK" | "UNAVAILABLE" = "OK";
    let payoutsDownstream: "OK" | "UNAVAILABLE" = "OK";
    let paymentSessionsDownstream: "OK" | "UNAVAILABLE" = "OK";

    const financialResult = await financialPromise;
    if (financialResult.error) {
      console.warn("[admin-finance-reconciliation] wallet summary unavailable:", financialResult.error.message);
      walletDownstream = "UNAVAILABLE";
    }

    const financialRows = financialResult.error ? [] : (financialResult.data ?? []);
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
    if (pendingPayoutsResult.error) {
      console.warn("[admin-finance-reconciliation] payouts unavailable:", pendingPayoutsResult.error.message);
      payoutsDownstream = "UNAVAILABLE";
    }
    if (pendingCashoutsResult.error) {
      console.warn("[admin-finance-reconciliation] cashouts unavailable:", pendingCashoutsResult.error.message);
      // Cashouts feed wallet liability evidence — treat as wallet degradation.
      walletDownstream = "UNAVAILABLE";
    }

    const tripRows = (tripResult.data || []) as TripAuditSourceRow[];
    const tripIds = tripRows.map((t) => t.id);
    let paymentRows: Array<{
      captured_amount_pence: number | null;
      status: string | null;
      trip_id: string | null;
      provider_status: string | null;
      stripe_payment_intent_id: string | null;
      provider_available_on: string | null;
    }> = [];
    let paymentSessionRows: PaymentSessionMoneyRow[] = [];
    let auditPaymentBadgeRows: Array<{
      trip_id: string | null;
      status: string | null;
      provider_status: string | null;
      captured_amount_pence: number | null;
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
      const [paymentsRes, paymentSessionsRes, payoutItemsRes, tripLedgerRes] = await Promise.all([
        supabase
          .from("payments")
          .select("captured_amount_pence, status, trip_id, provider_status, stripe_payment_intent_id, provider_available_on")
          .in("trip_id", tripIds),
        supabase
          .from("payment_sessions")
          .select(PAYMENT_SESSION_MONEY_SELECT)
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
      if (paymentSessionsRes.error) {
        console.warn("[admin-finance-reconciliation] payment_sessions evidence unavailable:", paymentSessionsRes.error.message);
        paymentSessionsDownstream = "UNAVAILABLE";
        paymentSessionRows = [];
        paymentRows = [];
      } else {
        paymentSessionsDownstream = "OK";
        paymentSessionRows = (paymentSessionsRes.data ?? []) as PaymentSessionMoneyRow[];
        paymentRows = mergePaymentSessionsIntoCaptureRows({
          paymentSessions: paymentSessionRows,
        }).rows;
      }
      // Legacy payments: PI / provider status for badges only — amounts come from paymentSessions.
      auditPaymentBadgeRows = (paymentsRes.error ? [] : (paymentsRes.data || [])).map((p) => ({
        trip_id: p.trip_id ?? null,
        status: p.status,
        provider_status: p.provider_status,
        captured_amount_pence: null,
        stripe_payment_intent_id: p.stripe_payment_intent_id ?? null,
        provider_available_on: p.provider_available_on ?? null,
      }));
      if (paymentsRes.error) {
        console.warn("[admin-finance-reconciliation] legacy payments badge evidence unavailable:", paymentsRes.error.message);
      }
      if (payoutItemsRes.error) {
        console.warn("[admin-finance-reconciliation] trip payout evidence unavailable:", payoutItemsRes.error.message);
        payoutsDownstream = "UNAVAILABLE";
        auditPayoutItems = [];
      } else {
        auditPayoutItems = payoutItemsRes.data || [];
      }
      if (tripLedgerRes.error) {
        console.warn("[admin-finance-reconciliation] wallet ledger evidence unavailable:", tripLedgerRes.error.message);
        walletDownstream = "UNAVAILABLE";
        auditLedgerRows = [];
      } else {
        auditLedgerRows = (tripLedgerRes.data || []).map((row) => ({
          related_trip_id: row.related_trip_id ?? null,
          type: row.type,
          amount_pence: row.amount_pence,
          stripe_payout_id: row.stripe_payout_id ?? null,
          stripe_transfer_id: row.stripe_transfer_id ?? null,
        }));
      }
    } else if (tripIds.length > 0 && summaryOnly) {
      const paymentSessionsRes = await supabase
        .from("payment_sessions")
        .select(PAYMENT_SESSION_MONEY_SELECT)
        .in("trip_id", tripIds);
      if (paymentSessionsRes.error) {
        console.warn("[admin-finance-reconciliation] payment_sessions evidence unavailable:", paymentSessionsRes.error.message);
        paymentSessionsDownstream = "UNAVAILABLE";
        paymentSessionRows = [];
        paymentRows = [];
      } else {
        paymentSessionsDownstream = "OK";
        paymentSessionRows = (paymentSessionsRes.data ?? []) as PaymentSessionMoneyRow[];
        paymentRows = mergePaymentSessionsIntoCaptureRows({
          paymentSessions: paymentSessionRows,
        }).rows;
      }
    }

    const finance = sumTripFinanceMetrics(tripRows);
    const commissionableRevenue = sumCommissionableFromTrips(
      tripRows,
      sumCapturedPaymentsByTripId(paymentRows),
    );

    const currencyCodeByServiceAreaId = await buildServiceAreaCurrencyMap(supabase, tripRows);
    const auditContext = buildTripFinancialAuditContext({
      payments: auditPaymentBadgeRows,
      payoutItems: auditPayoutItems,
      ledgerRows: auditLedgerRows,
      paymentSessions: paymentSessionRows,
      currencyCodeByServiceAreaId,
      defaultCurrencyCode: currency.toUpperCase(),
    });

    const walletBalance = computeLedgerWalletBalancePence(ledgerRows);
    const reservedCashout = financialRows.reduce((s, d) => s + Number(d.reserved_cashout_pence || 0), 0);

    const pendingPayout = (pendingPayoutsResult.data || []).reduce((s, p) => s + Number(p.amount_pence || 0), 0);
    const pendingCashout = (pendingCashoutsResult.data || []).reduce(
      (s, c) => s + Number(c.driver_receives_pence ?? c.requested_cashout_pence ?? 0),
      0,
    );
    const inFlightCashout = pendingCashout + reservedCashout;
    const pendingTransfers = pendingPayout + inFlightCashout;

    const scopeHeavyStripe = Boolean(resolvedRegionId || serviceAreaId);

    // FR must not call Revolut/Stripe balance APIs to create a second payment truth.
    // Provider balance refresh belongs to Payment Sessions / Payout Ledger.
    const stripeAvailablePence = 0;
    const stripePendingPence = 0;
    const stripeBalanceError: string | null = "PROVIDER_BALANCE_NOT_QUERIED_BY_FR";
    const moneyMovement = undefined;

    if (driverId) {
      const perDriver = await fetchPerDriverFinancialReconciliation(supabase, {
        driverId,
        regionId: resolvedRegionId,
        periodFrom,
        periodTo,
        providerAvailableBalancePence: financeScopeProvider.manual_provider_payout
          ? Number.MAX_SAFE_INTEGER
          : stripeAvailablePence,
        providerPendingBalancePence: stripePendingPence,
        sourceTier: "LIVE",
        manualProviderPayout: financeScopeProvider.manual_provider_payout,
      });

      return new Response(JSON.stringify({
        period: { from: periodFrom, to: periodTo },
        currency_code: currency.toUpperCase(),
        finance_reconciliation_driver_ssot: perDriver,
        meta: {
          driver_id: driverId,
          ssot_version: "financial_reconciliation_ssot_v1",
          data_source_badge: perDriver.source_tier,
          payment_provider: financeScopeProvider.provider,
          provider_balance_error: stripeBalanceError,
          stripe_balance_error: stripeBalanceError,
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { failedWebhookCount, lastWebhookAt } = webhookHealth;
    const providerHealth = computeProviderHealthStatus({
      stripeBalanceError,
      stripeSecretConfigured: Boolean(stripeSecretKey),
      connectBundleExpected: scopeHeavyStripe && !summaryOnly,
      connectBundleLoaded: moneyMovement != null,
      failedWebhookCount,
    });

    const ssotMetrics = computeSSOTMetrics({
      payments: paymentRows,
      trips: tripRows,
      ledger: ledgerRows,
      providerAvailableBalancePence: stripeAvailablePence,
      providerPendingBalancePence: stripePendingPence,
      paymentSessions: paymentSessionRows,
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

    const regionIdsFromDrivers = financialRows
      .map((d) => String(d.region_id ?? ""))
      .filter(Boolean);
    const { meta: currencyMeta, currencyGroups: baseCurrencyGroups } = await resolveFinanceCurrencyScope(
      supabase,
      {
        resolvedRegionId: resolvedRegionId ?? null,
        serviceAreaId: serviceAreaId ?? null,
        regionIdsFromDrivers,
      },
    );

    let currency_groups = baseCurrencyGroups;
    if (currencyMeta.is_mixed_currency_scope && tripRows.length > 0) {
      const serviceAreaIds = [...new Set(
        tripRows.map((t) => t.service_area_id).filter((id): id is string => Boolean(id)),
      )];
      if (serviceAreaIds.length > 0) {
        const { data: serviceAreas } = await supabase
          .from("service_areas")
          .select("id, region_id")
          .in("id", serviceAreaIds);
        const regionIds = [...new Set(
          (serviceAreas ?? []).map((sa) => sa.region_id).filter((id): id is string => Boolean(id)),
        )];
        const { data: regions } = regionIds.length > 0
          ? await supabase.from("regions").select("id, currency_code").in("id", regionIds)
          : { data: [] as Array<{ id: string; currency_code: string }> };
        const regionToCurrency = new Map(
          (regions ?? []).map((r) => [r.id, String(r.currency_code).toUpperCase()]),
        );
        const saToCurrency = new Map(
          (serviceAreas ?? []).map((sa) => [
            sa.id,
            regionToCurrency.get(sa.region_id) ?? "GBP",
          ]),
        );
        currency_groups = buildCurrencyGroupsFromTrips(
          tripRows,
          saToCurrency,
          sumCapturedPaymentsByTripId(paymentRows),
        );
      }
    }

    currency = currencyMeta.currency_code.toLowerCase();

    const trip_financial_audit = summaryOnly
      ? []
      : search?.trim()
      ? await (async () => {
        let auditSearchQuery = buildFinanceReconciliationTripQuery(supabase, {
          periodFrom,
          periodTo,
          auditLimit: Math.min(auditLimit, 50),
          select: TRIP_AUDIT_SELECT,
        });

        auditSearchQuery = await applyFinanceReconciliationTripLocationFilter(
          auditSearchQuery,
          supabase,
          { regionId: resolvedRegionId, serviceAreaId },
        );

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

        const [paymentsRes, paymentSessionsRes, payoutItemsRes, tripLedgerRes] = await Promise.all([
          supabase
            .from("payments")
            .select("captured_amount_pence, status, trip_id, provider_status, stripe_payment_intent_id, provider_available_on")
            .in("trip_id", auditTripIds),
          supabase
            .from("payment_sessions")
            .select(PAYMENT_SESSION_MONEY_SELECT)
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
        if (paymentSessionsRes.error) {
          console.warn("[admin-finance-reconciliation] search payment_sessions unavailable:", paymentSessionsRes.error.message);
          paymentSessionsDownstream = "UNAVAILABLE";
        }
        if (paymentsRes.error) {
          console.warn("[admin-finance-reconciliation] search payment badge evidence unavailable:", paymentsRes.error.message);
        }
        if (payoutItemsRes.error) {
          console.warn("[admin-finance-reconciliation] search payout evidence unavailable:", payoutItemsRes.error.message);
          payoutsDownstream = "UNAVAILABLE";
        }
        if (tripLedgerRes.error) {
          console.warn("[admin-finance-reconciliation] search wallet ledger unavailable:", tripLedgerRes.error.message);
          walletDownstream = "UNAVAILABLE";
        }

        const searchSessions = paymentSessionsRes.error
          ? []
          : ((paymentSessionsRes.data ?? []) as PaymentSessionMoneyRow[]);
        const searchAuditContext = buildTripFinancialAuditContext({
          payments: (paymentsRes.error ? [] : (paymentsRes.data || [])).map((p) => ({
            trip_id: p.trip_id ?? null,
            status: p.status,
            provider_status: p.provider_status,
            captured_amount_pence: null,
            stripe_payment_intent_id: p.stripe_payment_intent_id ?? null,
            provider_available_on: p.provider_available_on ?? null,
          })),
          payoutItems: payoutItemsRes.error ? [] : (payoutItemsRes.data || []),
          ledgerRows: tripLedgerRes.error
            ? []
            : (tripLedgerRes.data || []).map((row) => ({
              related_trip_id: row.related_trip_id ?? null,
              type: row.type,
              amount_pence: row.amount_pence,
              stripe_payout_id: row.stripe_payout_id ?? null,
              stripe_transfer_id: row.stripe_transfer_id ?? null,
            })),
          paymentSessions: searchSessions,
          currencyCodeByServiceAreaId,
          defaultCurrencyCode: currency.toUpperCase(),
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
    if (!summaryOnly && !driverId && scopeHeavyStripe) {
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
        const sessionData = await supabase
          .from("payment_sessions")
          .select("trip_id, captured_amount_pence, status")
          .in("trip_id", todayTripIds);
        todayPayments = mergePaymentSessionsIntoCaptureRows({
          paymentSessions: sessionData.data ?? [],
        }).rows;
      }
      const capturedByTrip = new Map<string, number>();
      for (const p of todayPayments) {
        if (!p.trip_id) continue;
        if (p.captured_amount_pence == null) continue;
        const cap = Number(p.captured_amount_pence);
        if (!Number.isFinite(cap) || cap < 0) continue;
        capturedByTrip.set(p.trip_id, (capturedByTrip.get(p.trip_id) ?? 0) + Math.round(cap));
      }

      const todayAuditRows = (todayTrips ?? []).map((t) => ({
        date: t.completed_at as string | null,
        payment_method: t.payment_method as string | null,
        captured_pence: capturedByTrip.get(t.id as string) ?? 0,
      }));

      const kpisResult = await withTimeout(
        "platform_kpis",
        STRIPE_SECTION_TIMEOUT_MS,
        fetchRegionPlatformKpis(supabase, {
          regionId: resolvedRegionId,
          stripe: null,
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
      const om = finance_reconciliation_summary.onecab_money;
      const cr = finance_reconciliation_summary.customer_revenue;
      const dm = finance_reconciliation_summary.driver_money;

      let chargebacks_pence: number | null = null;
      {
        let cbQuery = supabase
          .from("driver_wallet_ledger")
          .select("amount_pence")
          .eq("type", "CHARGEBACK_DEBIT")
          .gte("created_at", periodFrom)
          .lte("created_at", periodTo);
        if (resolvedRegionId) {
          const { data: regionDrivers } = await supabase
            .from("drivers")
            .select("id")
            .eq("region_id", resolvedRegionId);
          const ids = (regionDrivers ?? []).map((d) => d.id);
          if (ids.length > 0) cbQuery = cbQuery.in("driver_id", ids);
        }
        const { data: cbRows, error: cbErr } = await cbQuery;
        if (!cbErr) {
          chargebacks_pence = (cbRows ?? []).reduce(
            (s, row) => s + Math.abs(Number(row.amount_pence ?? 0)),
            0,
          );
        }
      }

      return new Response(JSON.stringify({
        period: { from: periodFrom, to: periodTo },
        currency_code: currency.toUpperCase(),
        profit_ssot: {
          platform_net_revenue_pence: net,
          expenses_pence,
          profit_before_tax_pence,
          gross_customer_revenue_pence: cr.total_customer_revenue_pence ?? null,
          gross_commission_pence: om.total_commission_earned_pence
            ?? om.onecab_gross_commission_pence
            ?? null,
          net_commission_pence: om.onecab_net_commission_pence ?? null,
          provider_fees_pence: om.provider_processing_fee_pence ?? null,
          refunds_pence: cr.refunded_amount_pence ?? null,
          chargebacks_pence,
          driver_payouts_pence: dm.driver_paid_out_pence ?? null,
        },
        meta: {
          ssot_version: SSOT_VERSION,
          data_source_badge: "LIVE",
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const service_area_payment_gateways = await resolveAllServiceAreaGatewayStatuses(supabase, {
      regionId: resolvedRegionId ?? null,
      serviceAreaId: serviceAreaId ?? null,
    });

    const generated_at = new Date().toISOString();
    // Provider balance is intentionally not queried by FR (not payment truth).
    const providerDownstream = "SKIPPED_BY_FR_AUDIT";
    const anyDownstreamUnavailable = [
      paymentSessionsDownstream,
      walletDownstream,
      payoutsDownstream,
    ].some((s) => s === "UNAVAILABLE");
    const pageStatus = anyDownstreamUnavailable ? "PARTIAL" : "LIVE";
    const auditRowOverview = buildFrAuditOverviewKpis(trip_financial_audit);
    const psCustomerMoney = buildFrCustomerMoneyKpisFromPaymentSessions(paymentSessionRows);
    // Customer money widgets = Payment Sessions only (never FR trip-fare rollup).
    const audit_overview_kpis = {
      ...auditRowOverview,
      completed_trip_fare_total_pence: psCustomerMoney.completed_trip_fare_total_pence,
      confirmed_provider_captured_total_pence: psCustomerMoney.confirmed_provider_captured_total_pence,
      refunded_total_pence: psCustomerMoney.refunded_total_pence,
      released_total_pence: psCustomerMoney.released_total_pence,
      provider_fee_total_pence: psCustomerMoney.provider_fee_total_pence,
      capture_shortfall_pence: psCustomerMoney.capture_shortfall_pence,
      overcapture_pence: psCustomerMoney.overcapture_pence,
      missing_captures_count: psCustomerMoney.missing_captures_count,
      missing_releases_count: psCustomerMoney.missing_releases_count,
      airport_charges_total_pence: psCustomerMoney.airport_charges_total_pence,
      driver_tips_total_pence: psCustomerMoney.driver_tips_total_pence,
    };

    return new Response(JSON.stringify({
      success: true,
      generated_at,
      status: pageStatus,
      period: { from: periodFrom, to: periodTo },
      currency_code: currencyMeta.currency_code,
      currency_symbol: currencyMeta.currency_symbol,
      currency_minor_unit: currencyMeta.currency_minor_unit,
      region_id: currencyMeta.region_id,
      service_area_id: currencyMeta.service_area_id,
      is_mixed_currency_scope: currencyMeta.is_mixed_currency_scope,
      currency_groups: currency_groups ?? undefined,
      finance_reconciliation_summary,
      platform_kpis,
      audit_overview_kpis,
      trip_financial_audit,
      trips: trip_financial_audit,
      drivers: undefined,
      mismatches: trip_financial_audit.filter((r) =>
        r.capture_mismatch
        || String(r.reconciliation_status?.tone ?? "").toLowerCase() === "error"
        || String(r.reconciliation_status?.label ?? "").toLowerCase().includes("mismatch")
      ),
      alerts: undefined,
      resolved_history: trip_financial_audit.filter((r) =>
        !r.capture_mismatch
        && String(r.reconciliation_status?.label ?? "").toLowerCase().includes("balanced")
      ),
      downstream_status: {
        payment_sessions: paymentSessionsDownstream,
        provider: providerDownstream,
        wallet: walletDownstream,
        payouts: payoutsDownstream,
      },
      stripe_payment_intents,
      legacy_manual_review_items: legacyManualReviewItems,
      money_movement: moneyMovement,
      service_area_payment_gateways,
      meta: {
        trip_count: finance.tripCount,
        audit_row_count: trip_financial_audit.length,
        payment_provider: financeScopeProvider.provider,
        payment_provider_environment: financeScopeProvider.environment,
        manual_provider_payout: financeScopeProvider.manual_provider_payout,
        provider_balance_error: stripeBalanceError,
        stripe_balance_error: stripeBalanceError,
        provider_balance_is_not_payment_truth: true,
        ssot_version: SSOT_VERSION,
        data_source_badge: pageStatus,
        accounting_rules: {
          card_customer_revenue: "sum(captured_amount_pence) where payments.status in captured|paid|succeeded — card only",
          pending_stripe_confirmation: "completed card trips without capture confirmation — excluded from reconciled totals",
          cash_collected_by_driver: "sum(cash trip fare) — not ONECAB Stripe revenue",
          onecab_card_commission: "sum(card trip commission_pence) capture-confirmed only, refund-adjusted",
          onecab_cash_commission_receivable: "sum(cash trip commission_pence) — owed by driver",
          onecab_card_net_commission: "onecab_card_commission - provider_processing_fees (card trips only)",
          total_commission_earned: "onecab_card_commission + onecab_cash_commission_receivable",
          net_platform_revenue: "total_commission_earned - stripe_processing_fees (card only; cash fee = 0)",
          cash_stripe_fees: "always 0 — cash trips have no Stripe processing fee",
          driver_payout_liability: "card_driver_payable - driver_paid_out + adjustments (excludes cash driver_net)",
          driver_wallet: "card: +driver_net+tips; cash: -commission (fare already with driver)",
          stripe_payout_confirmation: "driver bank receipt requires Stripe Connect payout paid + ledger stripe_payout_id",
          card_reconciliation:
            "card_customer_revenue = card_driver_payable + onecab_card_commission",
          historical_legacy_cash_trips:
            "excluded from digital finance reconciliation — audit display only",
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
