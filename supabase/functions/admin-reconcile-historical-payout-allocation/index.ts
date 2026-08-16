import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  allocatePayoutToEarnings,
  buildPayoutEventsFromRows,
  type AllocationCandidate,
  type AllocationResult,
} from "../_shared/historicalPayoutAllocation.ts";
import { writePayoutAllocationLine } from "../_shared/settlementLifecycleSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PRODUCTION_PROJECT_REF = "thazislrdkjpvvghtvzo";

type Mode = "dry_run" | "backfill";

type RequestBody = {
  mode?: Mode;
  driver_id?: string;
  allow_production?: boolean;
  allow_ambiguous?: boolean;
};

function isServiceRoleJwt(token: string, projectRef: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.role === "service_role" && payload.ref === projectRef;
  } catch {
    return false;
  }
}

function assertProductionAllowed(projectRef: string, allowProduction?: boolean): void {
  if (projectRef === PRODUCTION_PROJECT_REF && !allowProduction) {
    throw new Error(`Refusing production without allow_production=true`);
  }
}

type PoolRow = AllocationCandidate & { driver_id: string };

async function fetchAllocationPool(
  supabase: ReturnType<typeof createClient>,
  driverId?: string,
): Promise<PoolRow[]> {
  let query = supabase
    .from("driver_earning_settlement")
    .select(`
      id,
      ledger_entry_id,
      driver_id,
      allocated_to_payout,
      allocated_amount_pence,
      driver_wallet_ledger!inner (amount_pence, created_at)
    `)
    .eq("allocated_to_payout", false)
    .is("paid_in_batch_id", null);

  if (driverId) query = query.eq("driver_id", driverId);

  const { data, error } = await query;
  if (error) throw new Error(`Pool fetch failed: ${error.message}`);

  return (data ?? []).map((row) => {
    const ledger = row.driver_wallet_ledger as { amount_pence: number; created_at: string };
    const full = Number(ledger.amount_pence);
    const allocated = Number(row.allocated_amount_pence ?? 0);
    const remaining = Math.max(0, full - allocated);
    return {
      settlement_id: row.id as string,
      ledger_entry_id: row.ledger_entry_id as string,
      driver_id: row.driver_id as string,
      amount_pence: remaining,
      ledger_created_at: String(ledger.created_at),
    };
  }).filter((r) => r.amount_pence > 0);
}

async function writeAllocation(
  supabase: ReturnType<typeof createClient>,
  payout: import("../_shared/historicalPayoutAllocation.ts").PayoutEvent,
  match: { settlement_id: string; ledger_entry_id: string; amount_pence: number },
  allocatedAt: string,
): Promise<boolean> {
  try {
    await writePayoutAllocationLine({
      supabase,
      batchId: payout.batch_id,
      payoutItemId: payout.payout_item_id,
      sourceLedgerDebitId: payout.ledger_debit_id,
      line: {
        settlement_id: match.settlement_id,
        ledger_entry_id: match.ledger_entry_id,
        amount_pence: match.amount_pence,
      },
      paidAt: allocatedAt,
    });
    return true;
  } catch {
    return false;
  }
}

async function payoutAlreadyAllocated(
  supabase: ReturnType<typeof createClient>,
  payout: import("../_shared/historicalPayoutAllocation.ts").PayoutEvent,
): Promise<boolean> {
  if (payout.payout_item_id) {
    const { data } = await supabase
      .from("payout_item_ledger_allocations")
      .select("amount_pence")
      .eq("payout_item_id", payout.payout_item_id);
    const sum = (data ?? []).reduce((s, r) => s + Number(r.amount_pence), 0);
    return sum >= payout.amount_pence;
  }
  if (payout.ledger_debit_id) {
    const { data } = await supabase
      .from("payout_item_ledger_allocations")
      .select("amount_pence")
      .eq("source_ledger_debit_id", payout.ledger_debit_id);
    const sum = (data ?? []).reduce((s, r) => s + Number(r.amount_pence), 0);
    return sum >= payout.amount_pence;
  }
  return false;
}

async function runAllocation(
  supabase: ReturnType<typeof createClient>,
  mode: Mode,
  args: { driverId?: string; allowAmbiguous?: boolean },
) {
  const { data: payoutItems, error: piErr } = await supabase
    .from("payout_items")
    .select("id, driver_id, batch_id, status, amount_pence, driver_amount_pence, ledger_entry_id, provider_transfer_id, completed_at, created_at, manual_review_required, excluded_from_auto_allocation, manual_review_reason");
  if (piErr) throw new Error(piErr.message);

  const excludedPayoutItemIds = new Set(
    (payoutItems ?? [])
      .filter((p) => p.excluded_from_auto_allocation === true || p.manual_review_required === true)
      .map((p) => p.id as string),
  );

  const { data: ledgerDebits, error: ldErr } = await supabase
    .from("driver_wallet_ledger")
    .select("id, driver_id, type, amount_pence, created_at, provider_transfer_id")
    .in("type", ["PAYOUT", "WEEKLY_PAYOUT", "MANUAL_PAYOUT", "EARLY_CASHOUT"])
    .lt("amount_pence", 0);
  if (ldErr) throw new Error(ldErr.message);

  const linkedLedgerDebitIds = new Set(
    (payoutItems ?? [])
      .map((p) => p.ledger_entry_id)
      .filter(Boolean) as string[],
  );

  let events = buildPayoutEventsFromRows({
    payoutItems: payoutItems ?? [],
    ledgerDebits: ledgerDebits ?? [],
    linkedLedgerDebitIds,
  });

  if (args.driverId) {
    events = events.filter((e) => e.driver_id === args.driverId);
  }

  const fullPool = await fetchAllocationPool(supabase, args.driverId);
  const poolByDriver = new Map<string, AllocationCandidate[]>();
  for (const row of fullPool) {
    const list = poolByDriver.get(row.driver_id) ?? [];
    list.push(row);
    poolByDriver.set(row.driver_id, list);
  }

  const allocatedSettlementIds = new Set<string>();
  const results: AllocationResult[] = [];
  const ambiguous: AllocationResult[] = [];
  const manualReview: AllocationResult[] = [];
  const excludedFromAutoAllocation: Array<{
    payout_item_id: string | null;
    ledger_debit_id: string | null;
    driver_id: string;
    amount_pence: number;
    reason: string | null;
  }> = [];
  let allocationsWritten = 0;

  for (const payout of events) {
    if (payout.payout_item_id && excludedPayoutItemIds.has(payout.payout_item_id)) {
      const item = (payoutItems ?? []).find((p) => p.id === payout.payout_item_id);
      excludedFromAutoAllocation.push({
        payout_item_id: payout.payout_item_id,
        ledger_debit_id: payout.ledger_debit_id,
        driver_id: payout.driver_id,
        amount_pence: payout.amount_pence,
        reason: (item?.manual_review_reason as string | null) ?? "manual_review_required",
      });
      continue;
    }
    if (await payoutAlreadyAllocated(supabase, payout)) continue;

    const driverPool = (poolByDriver.get(payout.driver_id) ?? [])
      .filter((c) => !allocatedSettlementIds.has(c.settlement_id));

    const result = allocatePayoutToEarnings(payout, driverPool);
    results.push(result);

    if (result.ambiguous) {
      ambiguous.push(result);
      manualReview.push(result);
      continue;
    }

    if (mode === "backfill") {
      const allocatedAt = payout.paid_at;
      for (const match of result.matches) {
        const ok = await writeAllocation(supabase, payout, match, allocatedAt);
        if (ok) {
          allocatedSettlementIds.add(match.settlement_id);
          allocationsWritten += 1;
        }
      }
    } else {
      for (const match of result.matches) {
        allocatedSettlementIds.add(match.settlement_id);
      }
    }
  }

  const allocatedCount = results
    .filter((r) => !r.ambiguous)
    .reduce((s, r) => s + r.matches.length, 0);

  return {
    mode,
    historical_payout_count: events.length,
    allocations_planned: allocatedCount,
    allocations_written: mode === "backfill" ? allocationsWritten : 0,
    ambiguous_matches: ambiguous.length,
    manual_review: manualReview.map((r) => ({
      payout: r.payout,
      reason: r.ambiguous_reason,
      matched_rows: r.matches.length,
      match_method: r.match_method,
    })),
    excluded_from_auto_allocation: excludedFromAutoAllocation,
    payout_results: results.map((r) => ({
      driver_id: r.payout.driver_id,
      amount_pence: r.payout.amount_pence,
      source: r.payout.source,
      payout_item_id: r.payout.payout_item_id,
      ledger_debit_id: r.payout.ledger_debit_id,
      match_method: r.match_method,
      ambiguous: r.ambiguous,
      allocated_earnings: r.matches.length,
    })),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const token = authHeader.replace("Bearer ", "");
  const envServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const projectRef = supabaseUrl.match(/https:\/\/([^.]+)\./)?.[1] ?? "";

  if (token !== envServiceKey && !isServiceRoleJwt(token, projectRef)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as RequestBody;
    assertProductionAllowed(projectRef, body.allow_production);

    const supabase = createClient(supabaseUrl, envServiceKey, {
      auth: { persistSession: false },
    });

    const mode: Mode = body.mode ?? "dry_run";
    const result = await runAllocation(supabase, mode, {
      driverId: body.driver_id,
      allowAmbiguous: body.allow_ambiguous,
    });

    return new Response(JSON.stringify({
      success: true,
      project_ref: projectRef,
      ...result,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[admin-reconcile-historical-payout-allocation]", error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
