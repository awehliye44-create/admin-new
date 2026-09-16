/**
 * Persist and assert payout_item_ledger_allocations before bank transfer.
 * Amount comes from eligibility-proven DWL entries — never trip totals.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertAllocationEqualsAmount } from "./payoutAllocationEligibilitySSOT.ts";
import type { PlannedLedgerAllocation } from "./payoutLedgerHandoffSSOT.ts";

export const PAYOUT_LINEAGE_MISSING = "PAYOUT_LINEAGE_MISSING" as const;
export const PAYOUT_LINEAGE_MISMATCH = "PAYOUT_LINEAGE_MISMATCH" as const;

export async function persistPayoutItemLedgerAllocations(args: {
  supabase: SupabaseClient;
  payout_item_id: string;
  allocations: PlannedLedgerAllocation[];
  amount_pence: number;
}): Promise<void> {
  const itemId = String(args.payout_item_id ?? "").trim();
  if (!itemId) throw new Error(PAYOUT_LINEAGE_MISSING);
  assertAllocationEqualsAmount(args.allocations, args.amount_pence);
  if (args.allocations.length === 0) {
    throw new Error(PAYOUT_LINEAGE_MISSING);
  }

  const { data: existing, error: existingErr } = await args.supabase
    .from("payout_item_ledger_allocations")
    .select("id, ledger_entry_id, amount_pence")
    .eq("payout_item_id", itemId);
  if (existingErr) throw new Error(existingErr.message);
  if ((existing ?? []).length > 0) {
    assertAllocationEqualsAmount(
      (existing ?? []).map((row) => ({ amount_pence: Number(row.amount_pence ?? 0) })),
      args.amount_pence,
    );
    await assertPayoutItemLedgerLineage({
      supabase: args.supabase,
      payout_item_id: itemId,
      expected_amount_pence: args.amount_pence,
    });
    return;
  }

  const { error } = await args.supabase.from("payout_item_ledger_allocations").insert(
    args.allocations.map((line) => ({
      payout_item_id: itemId,
      ledger_entry_id: line.ledger_entry_id,
      amount_pence: line.amount_pence,
      allocated_at: new Date().toISOString(),
    })),
  );
  if (error) throw new Error(error.message);
  await assertPayoutItemLedgerLineage({
    supabase: args.supabase,
    payout_item_id: itemId,
    expected_amount_pence: args.amount_pence,
  });
}

export async function assertPayoutItemLedgerLineage(args: {
  supabase: SupabaseClient;
  payout_item_id: string;
  expected_amount_pence?: number;
}): Promise<void> {
  const itemId = String(args.payout_item_id ?? "").trim();
  if (!itemId) throw new Error(PAYOUT_LINEAGE_MISSING);
  const { error } = await args.supabase.rpc("assert_payout_item_ledger_lineage", {
    p_payout_item_id: itemId,
  });
  if (error) {
    throw new Error(error.message || PAYOUT_LINEAGE_MISSING);
  }
  if (args.expected_amount_pence == null) return;
  const { data: rows, error: allocErr } = await args.supabase
    .from("payout_item_ledger_allocations")
    .select("amount_pence")
    .eq("payout_item_id", itemId);
  if (allocErr) throw new Error(allocErr.message);
  assertAllocationEqualsAmount(
    (rows ?? []).map((row) => ({ amount_pence: Number(row.amount_pence ?? 0) })),
    args.expected_amount_pence,
  );
}
