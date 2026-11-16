/**
 * P1-3A: Historical payout → earning allocation (metadata only).
 * Sources: payout_items, payout_batches, driver_wallet_ledger debits.
 */

export const COMPLETED_PAYOUT_STATUSES = new Set([
  "completed", "COMPLETED", "SENT", "PAID", "SUCCESS", "paid", "sent",
]);

export const PAYOUT_DEBIT_TYPES = new Set([
  "PAYOUT", "WEEKLY_PAYOUT", "MANUAL_PAYOUT", "EARLY_CASHOUT",
]);

export type AllocationCandidate = {
  settlement_id: string;
  ledger_entry_id: string;
  amount_pence: number;
  ledger_created_at: string;
};

export type PayoutEvent = {
  source: "payout_item" | "ledger_debit";
  payout_item_id: string | null;
  batch_id: string | null;
  ledger_debit_id: string | null;
  driver_id: string;
  amount_pence: number;
  paid_at: string;
  provider_transfer_id: string | null;
  confidence: "explicit" | "ledger_linked";
};

export type AllocationMatch = {
  settlement_id: string;
  ledger_entry_id: string;
  amount_pence: number;
};

export type AllocationResult = {
  payout: PayoutEvent;
  matches: AllocationMatch[];
  match_method: "exact_subset" | "greedy_fifo" | "greedy_fifo_partial";
  ambiguous: boolean;
  ambiguous_reason: string | null;
};

/** Find exact subset of whole rows summing to target (small n only). */
export function findExactSubsetSum(
  candidates: AllocationCandidate[],
  target: number,
): AllocationCandidate[] | null {
  if (target <= 0) return [];
  if (candidates.length > 24) return null;

  const sorted = [...candidates].sort(
    (a, b) => new Date(a.ledger_created_at).getTime() - new Date(b.ledger_created_at).getTime(),
  );

  let found: AllocationCandidate[] | null = null;

  function search(index: number, remaining: number, picked: AllocationCandidate[]): void {
    if (found) return;
    if (remaining === 0) {
      found = [...picked];
      return;
    }
    if (index >= sorted.length || remaining < 0) return;

    const cur = sorted[index];
    search(index + 1, remaining, picked);
    if (found) return;
    if (cur.amount_pence <= remaining) {
      picked.push(cur);
      search(index + 1, remaining - cur.amount_pence, picked);
      picked.pop();
    }
  }

  search(0, target, []);
  return found;
}

/** Greedy oldest-first; partial final row when explicit payout and remainder > 0. */
export function greedyFifoAllocate(
  candidates: AllocationCandidate[],
  target: number,
  allowPartialFinal = false,
): { matches: Array<AllocationCandidate & { allocated_pence: number }>; ambiguous: boolean; remainder: number } {
  const sorted = [...candidates].sort(
    (a, b) => new Date(a.ledger_created_at).getTime() - new Date(b.ledger_created_at).getTime(),
  );
  const matches: Array<AllocationCandidate & { allocated_pence: number }> = [];
  let remaining = target;

  for (const row of sorted) {
    if (remaining <= 0) break;
    if (row.amount_pence <= remaining) {
      matches.push({ ...row, allocated_pence: row.amount_pence });
      remaining -= row.amount_pence;
    } else if (allowPartialFinal) {
      matches.push({ ...row, allocated_pence: remaining });
      remaining = 0;
      break;
    }
  }

  return { matches, ambiguous: remaining !== 0, remainder: remaining };
}

export function allocatePayoutToEarnings(
  payout: PayoutEvent,
  pool: AllocationCandidate[],
): AllocationResult {
  const eligible = pool.filter(
    (c) => new Date(c.ledger_created_at).getTime() <= new Date(payout.paid_at).getTime(),
  );

  const exact = findExactSubsetSum(eligible, payout.amount_pence);
  if (exact) {
    return {
      payout,
      matches: exact.map((c) => ({
        settlement_id: c.settlement_id,
        ledger_entry_id: c.ledger_entry_id,
        amount_pence: c.amount_pence,
      })),
      match_method: "exact_subset",
      ambiguous: false,
      ambiguous_reason: null,
    };
  }

  const allowPartial = payout.confidence === "explicit" || payout.source === "payout_item";
  const greedy = greedyFifoAllocate(eligible, payout.amount_pence, allowPartial);
  return {
    payout,
    matches: greedy.matches.map((c) => ({
      settlement_id: c.settlement_id,
      ledger_entry_id: c.ledger_entry_id,
      amount_pence: c.allocated_pence,
    })),
    match_method: allowPartial && !greedy.ambiguous ? "greedy_fifo_partial" : "greedy_fifo",
    ambiguous: greedy.ambiguous,
    ambiguous_reason: greedy.ambiguous
      ? `No exact subset for ${payout.amount_pence}p; FIFO remainder ${greedy.remainder}p`
      : null,
  };
}

export function buildPayoutEventsFromRows(args: {
  payoutItems: Array<{
    id: string;
    driver_id: string;
    batch_id: string | null;
    status: string;
    amount_pence: number;
    driver_amount_pence: number | null;
    ledger_entry_id: string | null;
    provider_transfer_id: string | null;
    completed_at: string | null;
    created_at: string;
  }>;
  ledgerDebits: Array<{
    id: string;
    driver_id: string;
    type: string;
    amount_pence: number;
    created_at: string;
    provider_transfer_id: string | null;
  }>;
  linkedLedgerDebitIds: Set<string>;
}): PayoutEvent[] {
  const events: PayoutEvent[] = [];

  for (const item of args.payoutItems) {
    if (!COMPLETED_PAYOUT_STATUSES.has(item.status)) continue;
    const amount = Math.abs(item.driver_amount_pence ?? item.amount_pence ?? 0);
    if (amount <= 0) continue;

    events.push({
      source: "payout_item",
      payout_item_id: item.id,
      batch_id: item.batch_id,
      ledger_debit_id: item.ledger_entry_id,
      driver_id: item.driver_id,
      amount_pence: amount,
      paid_at: item.completed_at ?? item.created_at,
      provider_transfer_id: item.provider_transfer_id,
      confidence: item.ledger_entry_id ? "explicit" : "ledger_linked",
    });
  }

  for (const debit of args.ledgerDebits) {
    if (!PAYOUT_DEBIT_TYPES.has(debit.type)) continue;
    if (args.linkedLedgerDebitIds.has(debit.id)) continue;
    const amount = Math.abs(debit.amount_pence);
    if (amount <= 0) continue;

    events.push({
      source: "ledger_debit",
      payout_item_id: null,
      batch_id: null,
      ledger_debit_id: debit.id,
      driver_id: debit.driver_id,
      amount_pence: amount,
      paid_at: debit.created_at,
      provider_transfer_id: debit.provider_transfer_id,
      confidence: "ledger_linked",
    });
  }

  events.sort(
    (a, b) => new Date(a.paid_at).getTime() - new Date(b.paid_at).getTime(),
  );

  return events;
}
