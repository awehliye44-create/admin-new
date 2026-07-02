import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";
import {
  aggregateMondayPayoutTodayCards,
  buildMondayPayoutDiagnosticsRow,
  filterMondayPayoutRowsForLondonToday,
  filterMondayPayoutRowsForPeriod,
  londonTodayStartIso,
  type MondayPayoutDiagnosticsRow,
} from "../_shared/mondayPayoutDiagnostics.ts";
import {
  syncStripeConnectPayoutsForRegion,
} from "../_shared/stripeConnectPayoutSync.ts";
import { readPlatformAvailablePence } from "../_shared/payoutRetryGuard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-region-id, x-service-area-id",
};

async function resolveRegionId(
  supabase: ReturnType<typeof createClient>,
  regionId: string | null,
  serviceAreaId: string | null,
): Promise<string | null> {
  if (regionId) return regionId;
  if (!serviceAreaId) return null;
  const { data } = await supabase
    .from("service_areas")
    .select("region_id")
    .eq("id", serviceAreaId)
    .maybeSingle();
  return data?.region_id ?? null;
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
    const rawRegionId = url.searchParams.get("region_id") ??
      req.headers.get("x-region-id");
    const rawServiceAreaId = url.searchParams.get("service_area_id") ??
      req.headers.get("x-service-area-id");
    const driverId = url.searchParams.get("driver_id");
    const includeAllKinds = url.searchParams.get("all_kinds") === "true";
    const todayOnly = url.searchParams.get("today") !== "false";
    const periodFrom = url.searchParams.get("from");
    const periodTo = url.searchParams.get("to");

    const regionId = await resolveRegionId(supabase, rawRegionId, rawServiceAreaId);
    const todayStart = londonTodayStartIso();
    const resolvedFrom = periodFrom ?? (todayOnly ? todayStart : null);
    const resolvedTo = periodTo ?? null;

    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    let platformAvailablePence: number | null = null;
    let stripePayoutSync: { accounts_synced: number; payouts_synced: number } | null = null;

    if (stripeSecretKey) {
      const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });
      platformAvailablePence = await readPlatformAvailablePence(stripe, "gbp");
      try {
        stripePayoutSync = await syncStripeConnectPayoutsForRegion({
          supabase,
          stripe,
          regionId,
          currency: "gbp",
        });
      } catch (syncErr) {
        console.warn("[admin-monday-payout-diagnostics] stripe payout sync:", syncErr);
      }
    }

    let stripePayoutQuery = supabase
      .from("stripe_connect_payouts")
      .select(`
        payout_id, connected_account_id, driver_id, amount_pence, currency, status,
        initiated_at, arrival_date, bank_last4, failure_code, failure_message,
        balance_transaction_id, payout_method, statement_descriptor, last_synced_at,
        drivers:driver_id (first_name, last_name, region_id)
      `)
      .order("initiated_at", { ascending: false })
      .limit(200);

    if (resolvedFrom) stripePayoutQuery = stripePayoutQuery.gte("initiated_at", resolvedFrom);
    if (resolvedTo) stripePayoutQuery = stripePayoutQuery.lte("initiated_at", resolvedTo);

    const { data: stripePayoutRows } = await stripePayoutQuery;

    let batchQuery = supabase
      .from("payout_batches")
      .select("id, kind, run_date, status, created_at")
      .order("created_at", { ascending: false })
      .limit(500);

    if (!includeAllKinds) {
      batchQuery = batchQuery.eq("kind", "WEEKLY_MONDAY");
    }
    if (resolvedFrom) {
      batchQuery = batchQuery.gte("created_at", resolvedFrom);
    }
    if (resolvedTo) {
      batchQuery = batchQuery.lte("created_at", resolvedTo);
    }

    const { data: batches, error: batchError } = await batchQuery;
    if (batchError) throw batchError;

    const batchMap = new Map((batches ?? []).map((b) => [b.id, b]));
    const batchIds = [...batchMap.keys()];

    if (batchIds.length === 0) {
      return new Response(JSON.stringify({
        today_cards: aggregateMondayPayoutTodayCards([]),
        today_period_start: resolvedFrom ?? todayStart,
        period_end: resolvedTo ?? null,
        payouts: [] as MondayPayoutDiagnosticsRow[],
        failed_payouts: [] as MondayPayoutDiagnosticsRow[],
        partial_settlements: [] as MondayPayoutDiagnosticsRow[],
        reconciliation_mismatches: [] as MondayPayoutDiagnosticsRow[],
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let itemQuery = supabase
      .from("payout_items")
      .select(`
        id, batch_id, driver_id, amount_pence, status,
        gross_payable_pence, cash_commission_recovered_pence, net_driver_payout_pence,
        driver_paid_out_pence, failed_payout_amount_pence, returned_to_wallet_pence,
        settlement_status, provider_status, provider_reference,
        failure_reason, error_message, ledger_sync_error,
        failure_code,
        stripe_transfer_id, stripe_payout_id,
        failed_at, created_at, completed_at, updated_at,
        drivers:driver_id (first_name, last_name, region_id)
      `)
      .in("batch_id", batchIds)
      .order("created_at", { ascending: false })
      .limit(500);

    if (driverId) {
      itemQuery = itemQuery.eq("driver_id", driverId);
    }

    const { data: items, error: itemError } = await itemQuery;
    if (itemError) throw itemError;

    const driverIds = [...new Set((items ?? []).map((i) => String(i.driver_id)))];
    const walletByDriver = new Map<string, number>();
    if (driverIds.length > 0) {
      const { data: walletRows } = await supabase
        .from("driver_financial_summary")
        .select("driver_id, wallet_balance")
        .in("driver_id", driverIds);
      for (const row of walletRows ?? []) {
        walletByDriver.set(String(row.driver_id), Number(row.wallet_balance ?? 0));
      }
    }

    const rows: MondayPayoutDiagnosticsRow[] = [];

    for (const item of items ?? []) {
      const driver = item.drivers as {
        first_name?: string;
        last_name?: string;
        region_id?: string;
      } | null;

      if (regionId && driver?.region_id !== regionId) continue;

      const batch = batchMap.get(item.batch_id);
      const driverName = driver
        ? `${driver.first_name ?? ""} ${driver.last_name ?? ""}`.trim()
        : null;

      rows.push(buildMondayPayoutDiagnosticsRow({
        item: item as Record<string, unknown>,
        batchKind: batch?.kind ?? "WEEKLY_MONDAY",
        driverName: driverName || null,
        driverWalletBalancePence: walletByDriver.get(String(item.driver_id)) ?? null,
        platformAvailablePence,
      }));
    }

    const stripeConnectPayouts = (stripePayoutRows ?? [])
      .filter((row) => {
        if (!regionId) return true;
        const driver = row.drivers as { region_id?: string } | null;
        return driver?.region_id === regionId;
      })
      .map((row) => {
        const driver = row.drivers as {
          first_name?: string;
          last_name?: string;
        } | null;
        const name = driver
          ? `${driver.first_name ?? ""} ${driver.last_name ?? ""}`.trim()
          : null;
        return {
          payout_id: String(row.payout_id),
          connected_account_id: String(row.connected_account_id),
          driver_id: row.driver_id as string | null,
          driver_name: name,
          amount_pence: Number(row.amount_pence ?? 0),
          currency: String(row.currency ?? "gbp"),
          status: String(row.status ?? ""),
          initiated_at: row.initiated_at as string | null,
          arrival_date: row.arrival_date as string | null,
          bank_last4: row.bank_last4 as string | null,
          failure_code: row.failure_code as string | null,
          failure_message: row.failure_message as string | null,
          balance_transaction_id: row.balance_transaction_id as string | null,
          payout_method: row.payout_method as string | null,
          statement_descriptor: row.statement_descriptor as string | null,
          last_synced_at: row.last_synced_at as string | null,
        };
      });

    const failedPayouts = rows.filter((r) =>
      r.payout_status === "failed" || r.payout_status === "ledger_sync_failed"
    );
    const partialSettlements = rows.filter((r) =>
      r.settlement_status === "PARTIAL_SETTLEMENT"
    );

    const periodRows = resolvedFrom && resolvedTo
      ? filterMondayPayoutRowsForPeriod(rows, resolvedFrom, resolvedTo)
      : resolvedFrom
      ? filterMondayPayoutRowsForLondonToday(rows, resolvedFrom)
      : rows;

    return new Response(JSON.stringify({
      today_cards: aggregateMondayPayoutTodayCards(periodRows),
      today_period_start: resolvedFrom ?? todayStart,
      period_end: resolvedTo ?? null,
      platform_available_pence: platformAvailablePence,
      stripe_payout_sync: stripePayoutSync,
      stripe_connect_payouts: stripeConnectPayouts,
      payouts: rows,
      failed_payouts: failedPayouts,
      partial_settlements: partialSettlements,
      reconciliation_mismatches: rows.filter((r) =>
        r.reconciliation_status === "RECONCILIATION_MISMATCH"
      ),
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[admin-monday-payout-diagnostics]", error);
    const message = error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
      ? String((error as { message: unknown }).message)
      : "Diagnostics query failed";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
