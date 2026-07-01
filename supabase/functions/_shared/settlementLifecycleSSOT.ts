/**
 * driver_earning_settlement lifecycle SSOT.
 * CREATED → TRANSFERRED_TO_CONNECT → INCLUDED_IN_PAYOUT → PAID
 * Does not alter wallet balance math — tracks settlement ↔ payout linkage only.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const SETTLEMENT_LIFECYCLE = {
  CREATED: "CREATED",
  TRANSFERRED_TO_CONNECT: "TRANSFERRED_TO_CONNECT",
  INCLUDED_IN_PAYOUT: "INCLUDED_IN_PAYOUT",
  PAID: "PAID",
} as const;

export type SettlementLifecycleStatus =
  (typeof SETTLEMENT_LIFECYCLE)[keyof typeof SETTLEMENT_LIFECYCLE];

export function deriveSettlementLifecycleStatus(row: {
  paid_in_payout_item_id?: string | null;
  paid_at?: string | null;
  allocated_amount_pence?: number | null;
  stripe_transfer_id?: string | null;
  ledger_amount_pence?: number;
}): SettlementLifecycleStatus {
  if (row.paid_in_payout_item_id && row.paid_at) {
    return SETTLEMENT_LIFECYCLE.PAID;
  }
  const allocated = Math.max(0, Number(row.allocated_amount_pence ?? 0));
  const full = Math.max(0, Number(row.ledger_amount_pence ?? 0));
  if (allocated > 0) {
    if (full > 0 && allocated >= full) {
      return SETTLEMENT_LIFECYCLE.PAID;
    }
    return SETTLEMENT_LIFECYCLE.INCLUDED_IN_PAYOUT;
  }
  if (row.stripe_transfer_id) {
    return SETTLEMENT_LIFECYCLE.TRANSFERRED_TO_CONNECT;
  }
  return SETTLEMENT_LIFECYCLE.CREATED;
}

export function lifecycleStatusAfterTransfer(
  current: SettlementLifecycleStatus | string | null | undefined,
): SettlementLifecycleStatus {
  if (current === SETTLEMENT_LIFECYCLE.PAID ||
    current === SETTLEMENT_LIFECYCLE.INCLUDED_IN_PAYOUT) {
    return current as SettlementLifecycleStatus;
  }
  return SETTLEMENT_LIFECYCLE.TRANSFERRED_TO_CONNECT;
}

type LedgerJoinRow = { amount_pence: number; created_at?: string };

function unwrapLedgerJoin(
  ledger: LedgerJoinRow | LedgerJoinRow[] | null | undefined,
): LedgerJoinRow {
  if (Array.isArray(ledger)) return ledger[0] ?? { amount_pence: 0 };
  return ledger ?? { amount_pence: 0 };
}

export type PayoutAllocationLine = {
  settlement_id: string;
  ledger_entry_id: string;
  amount_pence: number;
};

export async function writePayoutAllocationLine(args: {
  supabase: SupabaseClient;
  batchId: string | null;
  payoutItemId: string | null;
  sourceLedgerDebitId?: string | null;
  line: PayoutAllocationLine;
  paidAt: string;
}): Promise<{ fully_allocated: boolean }> {
  const { data: row, error: fetchErr } = await args.supabase
    .from("driver_earning_settlement")
    .select("allocated_amount_pence, paid_in_payout_item_id, driver_wallet_ledger!inner (amount_pence)")
    .eq("id", args.line.settlement_id)
    .maybeSingle();

  if (fetchErr || !row) {
    throw new Error(`Settlement ${args.line.settlement_id} not found`);
  }

  const ledger = unwrapLedgerJoin(
    row.driver_wallet_ledger as LedgerJoinRow | LedgerJoinRow[] | null,
  );
  const fullAmount = Math.max(0, Number(ledger.amount_pence));
  const prevAllocated = Number(row.allocated_amount_pence ?? 0);
  const newAllocated = prevAllocated + args.line.amount_pence;
  const fullyAllocated = fullAmount <= 0 || newAllocated >= fullAmount;

  const lifecycle = fullyAllocated
    ? SETTLEMENT_LIFECYCLE.PAID
    : SETTLEMENT_LIFECYCLE.INCLUDED_IN_PAYOUT;

  const { error: updErr } = await args.supabase
    .from("driver_earning_settlement")
    .update({
      allocated_to_payout: fullyAllocated,
      allocated_amount_pence: newAllocated,
      allocated_at: args.paidAt,
      paid_in_batch_id: fullyAllocated ? args.batchId : null,
      paid_in_payout_item_id: fullyAllocated ? args.payoutItemId : null,
      paid_at: fullyAllocated ? args.paidAt : null,
      settlement_lifecycle_status: lifecycle,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.line.settlement_id);

  if (updErr) throw new Error(`Settlement update failed: ${updErr.message}`);

  const allocInsert: Record<string, unknown> = {
    ledger_entry_id: args.line.ledger_entry_id,
    amount_pence: args.line.amount_pence,
    allocated_at: args.paidAt,
  };
  if (args.payoutItemId) {
    allocInsert.payout_item_id = args.payoutItemId;
  } else if (args.sourceLedgerDebitId) {
    allocInsert.source_ledger_debit_id = args.sourceLedgerDebitId;
  } else {
    throw new Error("payoutItemId or sourceLedgerDebitId required for allocation insert");
  }

  const { error: insErr } = await args.supabase
    .from("payout_item_ledger_allocations")
    .insert(allocInsert);

  if (insErr) throw new Error(`Allocation insert failed: ${insErr.message}`);

  return { fully_allocated: fullyAllocated };
}

type SettlementCandidate = {
  settlement_id: string;
  ledger_entry_id: string;
  amount_pence: number;
  ledger_created_at: string;
};

async function fetchUnsettledSettlementCandidates(
  supabase: SupabaseClient,
  driverId: string,
): Promise<SettlementCandidate[]> {
  const { data, error } = await supabase
    .from("driver_earning_settlement")
    .select(`
      id,
      ledger_entry_id,
      allocated_amount_pence,
      paid_in_payout_item_id,
      driver_wallet_ledger!inner (amount_pence, created_at)
    `)
    .eq("driver_id", driverId)
    .is("paid_in_payout_item_id", null)
    .neq("settlement_lifecycle_status", SETTLEMENT_LIFECYCLE.PAID);

  if (error) throw new Error(`Settlement pool fetch failed: ${error.message}`);

  return (data ?? []).map((row) => {
    const ledger = unwrapLedgerJoin(
      row.driver_wallet_ledger as LedgerJoinRow | LedgerJoinRow[] | null,
    );
    const full = Math.max(0, Number(ledger.amount_pence));
    const allocated = Math.max(0, Number(row.allocated_amount_pence ?? 0));
    const remaining = Math.max(0, full - allocated);
    return {
      settlement_id: row.id as string,
      ledger_entry_id: row.ledger_entry_id as string,
      amount_pence: remaining,
      ledger_created_at: String(ledger.created_at),
    };
  }).filter((r) => r.amount_pence > 0)
    .sort((a, b) =>
      new Date(a.ledger_created_at).getTime() - new Date(b.ledger_created_at).getTime()
    );
}

export function buildFifoSettlementAllocations(
  candidates: SettlementCandidate[],
  targetPence: number,
): PayoutAllocationLine[] {
  if (targetPence <= 0) return [];
  const lines: PayoutAllocationLine[] = [];
  let remaining = targetPence;

  for (const row of candidates) {
    if (remaining <= 0) break;
    const slice = Math.min(row.amount_pence, remaining);
    if (slice <= 0) continue;
    lines.push({
      settlement_id: row.settlement_id,
      ledger_entry_id: row.ledger_entry_id,
      amount_pence: slice,
    });
    remaining -= slice;
  }

  return lines;
}

/** After a successful payout debit, link ledger credits → payout item and advance lifecycle to PAID. */
export async function completePayoutSettlementLifecycle(args: {
  supabase: SupabaseClient;
  payoutItemId: string;
  batchId: string;
  driverId: string;
  payoutAmountPence: number;
  paidAt: string;
  sourceLedgerDebitId?: string | null;
}): Promise<{ allocations_written: number; lines: PayoutAllocationLine[] }> {
  const candidates = await fetchUnsettledSettlementCandidates(args.supabase, args.driverId);
  const lines = buildFifoSettlementAllocations(candidates, args.payoutAmountPence);

  let written = 0;
  for (const line of lines) {
    await writePayoutAllocationLine({
      supabase: args.supabase,
      batchId: args.batchId,
      payoutItemId: args.payoutItemId,
      sourceLedgerDebitId: args.sourceLedgerDebitId,
      line,
      paidAt: args.paidAt,
    });
    written += 1;
  }

  return { allocations_written: written, lines };
}
