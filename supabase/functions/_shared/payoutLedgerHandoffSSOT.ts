/**
 * Payout Ledger handoff SSOT (pure).
 *
 * PL consumes DWL available_balance_pence and eligible ledger entry IDs only.
 * Never recalculates earnings; never allocates non-eligible wallet rows.
 */

import { assertAllocationEqualsAmount } from "./payoutAllocationEligibilitySSOT.ts";

export type EligibleLedgerCredit = {
  ledger_entry_id: string;
  amount_pence: number;
};

export type PlannedLedgerAllocation = {
  ledger_entry_id: string;
  amount_pence: number;
};

function allocatedMap(
  source?: Map<string, number> | Record<string, number> | null,
): Map<string, number> {
  if (!source) return new Map();
  if (source instanceof Map) return source;
  return new Map(
    Object.entries(source).map(([k, v]) => [k, Math.max(0, Math.round(Number(v ?? 0)))]),
  );
}

/**
 * FIFO allocate payout amount across eligibility-proven ledger credits only.
 * Respects prior allocations so one wallet entry cannot be double-paid.
 */
export function planEligibleLedgerAllocations(args: {
  eligible_entries: EligibleLedgerCredit[];
  already_allocated_by_ledger?: Map<string, number> | Record<string, number> | null;
  amount_pence: number;
}): PlannedLedgerAllocation[] {
  const already = allocatedMap(args.already_allocated_by_ledger);
  let remaining = Math.max(0, Math.round(Number(args.amount_pence ?? 0)));
  const lines: PlannedLedgerAllocation[] = [];

  for (const entry of args.eligible_entries) {
    if (remaining <= 0) break;
    const ledgerId = String(entry.ledger_entry_id ?? "").trim();
    if (!ledgerId) continue;
    const credit = Math.max(0, Math.round(Number(entry.amount_pence ?? 0)));
    const prior = already.get(ledgerId) ?? 0;
    const available = Math.max(0, credit - prior);
    const slice = Math.min(available, remaining);
    if (slice <= 0) continue;
    lines.push({ ledger_entry_id: ledgerId, amount_pence: slice });
    remaining -= slice;
  }

  assertAllocationEqualsAmount(lines, args.amount_pence);
  return lines;
}

/** UI / API label — avoid Stripe-only "Connected Account" wording. */
export function payoutDestinationLabel(args: {
  provider?: string | null;
  connected_account_id?: string | null;
  manual_bank?: boolean;
}): string {
  const provider = String(args.provider ?? "").trim().toLowerCase();
  if (args.manual_bank || provider === "revolut") {
    return args.connected_account_id
      ? `Manual bank · ${String(args.connected_account_id).slice(0, 12)}`
      : "Manual bank";
  }
  if (args.connected_account_id) {
    return String(args.connected_account_id);
  }
  return "Not set";
}
