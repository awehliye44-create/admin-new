// v1.0.4 — never 5xx (Lovable blank-screen overlay); bound wallet ledger to period drivers
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

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
import { getLondonDayBounds, normalizeFinancePeriodParam } from "../_shared/financeLondonDay.ts";
import { FINANCIAL_MODEL, resolveServiceAreaFinancialScope } from "../_shared/financialModelScopeGate.ts";
import { resolvePlatformCollectedDriverIds } from "../_shared/platformCollectedDriverScope.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-region-id, x-service-area-id",
};

const MAX_LEDGER_DRIVER_IN = 150;
const LEDGER_PAGE_SIZE = 1000;
const MAX_LEDGER_PAGES_PER_CHUNK = 5;
const PROVIDER_SECTION_TIMEOUT_MS = 25_000;

type WalletLedgerRow = { driver_id: string; type: string; amount_pence: number };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

async function withTimeout<T>(
  label: string,
  ms: number,
  promise: Promise<T>,
): Promise<T | { __timeout: true; label: string }> {
  return await Promise.race<T | { __timeout: true; label: string }>([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ __timeout: true, label }), ms)),
  ]);
}

async function fetchAllTimeWalletLedgerRows(
  supabase: SupabaseClient,
  driverIds: string[],
): Promise<WalletLedgerRow[]> {
  if (driverIds.length === 0) return [];

  const rows: WalletLedgerRow[] = [];
  for (let i = 0; i < driverIds.length; i += MAX_LEDGER_DRIVER_IN) {
    const chunk = driverIds.slice(i, i + MAX_LEDGER_DRIVER_IN);
    for (let page = 0; page < MAX_LEDGER_PAGES_PER_CHUNK; page++) {
      const offset = page * LEDGER_PAGE_SIZE;
      const { data, error } = await supabase
        .from("driver_wallet_ledger")
        .select("driver_id, type, amount_pence")
        .in("driver_id", chunk)
        .order("created_at", { ascending: true })
        .range(offset, offset + LEDGER_PAGE_SIZE - 1);
      if (error) throw error;
      const batch = (data ?? []) as WalletLedgerRow[];
      rows.push(...batch);
      if (batch.length < LEDGER_PAGE_SIZE) break;
    }
  }
  return rows;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const providerSecretKey = Deno.env.get("REVOLUT_SECRET_KEY");
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Unauthorized", finance_backend_audit_v1: null });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return json({ error: "Unauthorized", finance_backend_audit_v1: null });
    }

    const { data: roleData } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();

    if (!roleData) {
      const { data: staffRow } = await supabase
        .from("staff_profiles")
        .select("id, role")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .maybeSingle();
      if (!staffRow) {
        return json({
          error: "Admin access required",
          finance_backend_audit_v1: null,
        });
      }
    }

    const url = new URL(req.url);
    const regionId = url.searchParams.get("region_id") || req.headers.get("x-region-id");
    const serviceAreaId = url.searchParams.get("service_area_id") || req.headers.get("x-service-area-id");
    const driverId = url.searchParams.get("driver_id");
    const periodFrom =
      normalizeFinancePeriodParam(url.searchParams.get("from"), "start")
      || getLondonDayBounds().start.toISOString();
    const periodTo =
      normalizeFinancePeriodParam(url.searchParams.get("to"), "end")
      || getLondonDayBounds().end.toISOString();
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

    // FR Alerts audit is PLATFORM_COLLECTED only — never mix CW SAs / drivers / trips.
    const modelScope = await resolveServiceAreaFinancialScope(
      supabase,
      FINANCIAL_MODEL.PLATFORM_COLLECTED,
      serviceAreaId,
    );
    if (!modelScope.ok) {
      return json({
        error: modelScope.error,
        error_code: modelScope.code,
        finance_backend_audit_v1: null,
      });
    }
    let serviceAreaIds = [...modelScope.allowedServiceAreaIds];
    if (resolvedRegionId && !serviceAreaId) {
      const { data: areas } = await supabase
        .from("service_areas")
        .select("id")
        .eq("region_id", resolvedRegionId);
      const regionSet = new Set((areas || []).map((a) => String(a.id)));
      serviceAreaIds = serviceAreaIds.filter((id) => regionSet.has(id));
    }
    const platformDriverIds = await resolvePlatformCollectedDriverIds(supabase, {
      service_area_id: serviceAreaId,
      allowed_service_area_ids: serviceAreaIds,
    });
    if (driverId && !platformDriverIds.includes(String(driverId))) {
      return json({
        error: "Driver is outside PLATFORM_COLLECTED scope",
        error_code: "FINANCIAL_MODEL_VIOLATION",
        finance_backend_audit_v1: null,
      });
    }

    let tripQuery = supabase
      .from("trips")
      .select(`
        id,
        trip_code,
        driver_id,
        commission_pence,
        provider_fee_pence,
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
        
        driver_tier_commission_percent,
        commission_pct,
        completed_at,
        service_area_id,
        driver:drivers!trips_driver_id_fkey(first_name, last_name)
      `)
      .eq("financial_model", FINANCIAL_MODEL.PLATFORM_COLLECTED)
      .gte("completed_at", periodFrom)
      .lte("completed_at", periodTo)
      .or(`financial_outcome.in.(${COUNTABLE_FINANCIAL_OUTCOMES.join(",")}),status.in.(completed,no_show)`)
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(auditLimit);

    if (serviceAreaIds.length) tripQuery = tripQuery.in("service_area_id", serviceAreaIds);
    if (driverId) tripQuery = tripQuery.eq("driver_id", driverId);

    const scopedDriverIds = driverId ? [String(driverId)] : platformDriverIds;

    let ledgerQuery = supabase
      .from("driver_wallet_ledger")
      .select("id, driver_id, type, amount_pence, provider_transfer_id, provider_payout_id, created_at")
      .gte("created_at", periodFrom)
      .lte("created_at", periodTo)
      .order("created_at", { ascending: false })
      .limit(5000);
    if (scopedDriverIds.length > 0) {
      ledgerQuery = ledgerQuery.in("driver_id", scopedDriverIds);
    } else {
      // No PLATFORM drivers in scope — force empty ledger (never all drivers).
      ledgerQuery = ledgerQuery.eq("driver_id", "00000000-0000-0000-0000-000000000000");
    }

    let payoutQuery = supabase
      .from("payout_items")
      .select(`
        id,
        driver_id,
        trip_id,
        amount_pence,
        driver_amount_pence,
        status,
        provider_transfer_id,
        provider_payout_id,
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
    if (scopedDriverIds.length > 0) {
      payoutQuery = payoutQuery.in("driver_id", scopedDriverIds);
    } else {
      payoutQuery = payoutQuery.eq("driver_id", "00000000-0000-0000-0000-000000000000");
    }

    let cashoutQuery = supabase
      .from("driver_early_cashouts")
      .select(`
        id,
        driver_id,
        status,
        requested_cashout_pence,
        driver_receives_pence,
        provider_transfer_id,
        provider_payout_id,
        ledger_cashout_id,
        created_at,
        paid_at
      `)
      .gte("created_at", periodFrom)
      .lte("created_at", periodTo)
      .order("created_at", { ascending: false })
      .limit(auditLimit);
    if (scopedDriverIds.length > 0) {
      cashoutQuery = cashoutQuery.in("driver_id", scopedDriverIds);
    } else {
      cashoutQuery = cashoutQuery.eq("driver_id", "00000000-0000-0000-0000-000000000000");
    }

    const [tripResult, ledgerResult, payoutResult, cashoutResult] = await Promise.all([
      tripQuery,
      ledgerQuery,
      payoutQuery,
      cashoutQuery,
    ]);

    if (tripResult.error) throw tripResult.error;
    if (ledgerResult.error) throw ledgerResult.error;
    if (payoutResult.error) throw payoutResult.error;
    if (cashoutResult.error) throw cashoutResult.error;

    const trips = (tripResult.data || []) as TripAuditSourceRow[];
    const payoutItems = ((payoutResult.data || []) as Array<PayoutItemRow & {
      payout_batches?: { kind?: string | null } | null;
    }>).map((item) => ({
      ...item,
      batch: item.payout_batches ?? item.batch ?? null,
    })) as PayoutItemRow[];
    const earlyCashouts = (cashoutResult.data || []) as EarlyCashoutRow[];
    const ledgerRows = (ledgerResult.data || []) as LedgerRow[];

    const periodDriverIds = driverId
      ? [driverId]
      : Array.from(new Set([
        ...trips.map((t) => t.driver_id).filter(Boolean) as string[],
        ...payoutItems.map((p) => p.driver_id).filter(Boolean),
        ...earlyCashouts.map((c) => c.driver_id).filter(Boolean),
      ]));

    let drivers: Array<{ id: string; first_name?: string | null; last_name?: string | null }> = [];
    let walletRows: Array<{ driver_id: string; available_pence: number | null }> = [];
    let walletLedgerRows: WalletLedgerRow[] = [];

    if (periodDriverIds.length > 0) {
      const driverNameRows: Array<{ id: string; first_name?: string | null; last_name?: string | null }> = [];
      const walletAcc: Array<{ driver_id: string; available_pence: number | null }> = [];
      for (let i = 0; i < periodDriverIds.length; i += MAX_LEDGER_DRIVER_IN) {
        const chunk = periodDriverIds.slice(i, i + MAX_LEDGER_DRIVER_IN);
        const [dRes, wRes] = await Promise.all([
          supabase.from("drivers").select("id, first_name, last_name").in("id", chunk),
          supabase.from("driver_wallets").select("driver_id, available_pence").in("driver_id", chunk),
        ]);
        if (dRes.error) throw dRes.error;
        if (wRes.error) throw wRes.error;
        driverNameRows.push(...(dRes.data ?? []));
        walletAcc.push(...(wRes.data ?? []));
      }
      drivers = driverNameRows;
      walletRows = walletAcc;
      walletLedgerRows = await fetchAllTimeWalletLedgerRows(supabase, periodDriverIds);
    }

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

    const walletByDriver = new Map<string, number>();
    for (const w of walletRows) {
      walletByDriver.set(w.driver_id, Number(w.available_pence || 0));
    }
    const ledgerWalletSumByDriver = sumLedgerWalletBalanceByDriver(walletLedgerRows);

    let providerAvailablePence = 0;
    let providerPendingPence = 0;
    const providerPlatformPayoutsPence = 0;
    let providerBalanceError: string | null = null;

    const financeScopeProvider = await resolveFinanceScopeProvider(supabase, {
      regionId: resolvedRegionId,
      serviceAreaId: serviceAreaId ?? null,
    });

    const providerBalanceResult = await withTimeout(
      "provider_platform_balance",
      PROVIDER_SECTION_TIMEOUT_MS,
      fetchProviderPlatformBalance(supabase, {
        provider: financeScopeProvider.provider,
        environment: financeScopeProvider.environment,
        currency,
      }),
    );

    if (providerBalanceResult && "__timeout" in providerBalanceResult) {
      providerBalanceError = `${providerBalanceResult.label} timed out after ${PROVIDER_SECTION_TIMEOUT_MS}ms`;
    } else {
      providerAvailablePence = providerBalanceResult.available_pence;
      providerPendingPence = providerBalanceResult.pending_pence;
      providerBalanceError = providerBalanceResult.error;
    }

    if (!providerSecretKey) {
      providerBalanceError = providerBalanceError ?? "REVOLUT_SECRET_KEY not configured";
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
      drivers,
      providerAvailablePence,
      providerPendingPence,
      providerPlatformPayoutsPence,
      providerBalanceError,
    });

    return json({
      finance_backend_audit_v1,
      provider_platform_payouts: {
        paid_today_pence: 0,
        paid_all_time_pence: 0,
        recent: [],
        note:
          "provider automatic platform payouts to ONECAB business bank — not the same as admin commission-sweep batches.",
      },
    });
  } catch (error) {
    console.error("[finance-backend-audit-v1]", error);
    // HTTP 200 so the admin overlay does not blank the whole Financial Reconciliation page.
    return json({
      error: errorMessage(error),
      finance_backend_audit_v1: null,
    });
  }
});
