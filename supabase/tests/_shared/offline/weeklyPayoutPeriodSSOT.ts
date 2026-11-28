/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Weekly payout earning-period SSOT.
 *
 * WEEKLY PAYOUT MANIFEST (canonical) =
 *   - unpaid eligible earnings from the previous completed London week
 *   - PLUS unpaid eligible arrears from any earlier completed week
 *   - excluding current-week earnings
 *   - excluding already allocated / reserved / debited / paid earnings
 *   - excluding earnings occupied by completed/in-flight early cash-out
 *   - excluding paused drivers (orchestrator eligibility)
 *   - exactly one consumer per earning (allocation occupancy + advisory lock)
 *
 * Occurrence period_start/period_end stay frozen to the previous completed week.
 * Older unpaid rows are selected as arrears inside that occurrence — they do not
 * widen the frozen period. Ledger allocations retain each earning’s original
 * economic period via ledger_entry_id → economic_earned_at / posting_created_at.
 */

import { zonedWallTimeToUtc } from "../../../functions/_shared/payoutScheduleSSOT.ts";

import {
  earningsAttributionInstant,
  isInstantInHalfOpenRange,
} from "../../../functions/_shared/economicEarnedAtSSOT.ts";


export const WEEKLY_NEVER_REPAY_LEDGER_TYPES = [
  "EARLY_CASHOUT",
  "CASHOUT_FEE",
  "WEEKLY_PAYOUT",
  "PAYOUT",
  "MANUAL_PAYOUT",
] as const;


export function remainingWeeklyPayableAfterEarlyAllocations(args: {
  previous_week_unpaid: ReadonlyArray<{ ledger_entry_id: string; unpaid_pence: number }>;
  early_allocations: ReadonlyArray<{ ledger_entry_id: string; amount_pence: number }>;
}): number {
  const taken = new Map<string, number>();
  for (const line of args.early_allocations) {
    const id = String(line.ledger_entry_id ?? "").trim();
    if (!id) continue;
    taken.set(id, (taken.get(id) ?? 0) + Math.max(0, Math.round(Number(line.amount_pence ?? 0))));
  }
  let remaining = 0;
  for (const row of args.previous_week_unpaid) {
    const unpaid = Math.max(0, Math.round(Number(row.unpaid_pence ?? 0)));
    const used = taken.get(String(row.ledger_entry_id)) ?? 0;
    remaining += Math.max(0, unpaid - used);
  }
  return remaining;
}

export * from "../../../functions/_shared/weeklyPayoutPeriodSSOT.ts";
