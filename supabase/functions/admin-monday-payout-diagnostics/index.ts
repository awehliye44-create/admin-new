import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  aggregateMondayPayoutTodayCards,
  buildMondayPayoutDiagnosticsRow,
  londonTodayStartIso,
  type MondayPayoutDiagnosticsRow,
} from "../_shared/mondayPayoutDiagnostics.ts";

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

    const regionId = await resolveRegionId(supabase, rawRegionId, rawServiceAreaId);
    const todayStart = londonTodayStartIso();

    let batchQuery = supabase
      .from("payout_batches")
      .select("id, kind, run_date, status, created_at")
      .order("created_at", { ascending: false })
      .limit(100);

    if (!includeAllKinds) {
      batchQuery = batchQuery.eq("kind", "WEEKLY_MONDAY");
    }
    if (todayOnly) {
      batchQuery = batchQuery.gte("created_at", todayStart);
    }

    const { data: batches, error: batchError } = await batchQuery;
    if (batchError) throw batchError;

    const batchMap = new Map((batches ?? []).map((b) => [b.id, b]));
    const batchIds = [...batchMap.keys()];

    if (batchIds.length === 0) {
      return new Response(JSON.stringify({
        today_cards: aggregateMondayPayoutTodayCards([]),
        payouts: [] as MondayPayoutDiagnosticsRow[],
        failed_payouts: [] as MondayPayoutDiagnosticsRow[],
        partial_settlements: [] as MondayPayoutDiagnosticsRow[],
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
        stripe_transfer_id, stripe_payout_id,
        failed_at, created_at, completed_at, updated_at,
        drivers:driver_id (first_name, last_name, region_id)
      `)
      .in("batch_id", batchIds)
      .order("created_at", { ascending: false });

    if (driverId) {
      itemQuery = itemQuery.eq("driver_id", driverId);
    }

    const { data: items, error: itemError } = await itemQuery;
    if (itemError) throw itemError;

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
      }));
    }

    const failedPayouts = rows.filter((r) =>
      r.payout_status === "failed" || r.payout_status === "ledger_sync_failed"
    );
    const partialSettlements = rows.filter((r) =>
      r.settlement_status === "PARTIAL_SETTLEMENT"
    );

    return new Response(JSON.stringify({
      today_cards: aggregateMondayPayoutTodayCards(rows),
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
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
