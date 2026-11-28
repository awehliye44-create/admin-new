/** Admin presentation-only helpers; not part of Edge uploads. */
/**
 * Slice 5 â Tuesday (settings-driven) weekly payout batch workflow SSOT.
 * Creates deterministic batches + items, then stops at BLOCKED_EXECUTION_DISABLED.
 * Never reserves wallets, never debit, never calls Revolut /pay.
 */

import {
  computeNextWeeklyPayoutRun,
  resolvePayoutTimezone,
  zonedWallTimeToUtc,
  type PayoutWeekday,
} from "../../supabase/functions/_shared/payoutScheduleSSOT.ts";

import {
  isConflictingActivePayoutItem,
  PAYOUT_ITEM_IN_FLIGHT_STATUSES,
} from "../../supabase/functions/_shared/payoutItemLifecycleSSOT.ts";
import { SLICE5_BATCH_STATUS, SLICE5_ITEM_STATUS, ADMIN_FUNDS_RESERVED_LABEL, ADMIN_EXECUTION_DISABLED_LABEL } from "../../supabase/functions/_shared/weeklyDriverPayoutBatchWorkflowSSOT.ts";

/** Legacy kind â retired from active scheduler writes. */
export const LEGACY_WEEKLY_MONDAY_KIND = "WEEKLY_MONDAY" as const;


export type Slice5BatchStatus =
  (typeof SLICE5_BATCH_STATUS)[keyof typeof SLICE5_BATCH_STATUS];


export type Slice5ItemStatus =
  (typeof SLICE5_ITEM_STATUS)[keyof typeof SLICE5_ITEM_STATUS];


export const SLICE5_ALLOWED_BATCH_STATUSES = new Set<string>(Object.values(SLICE5_BATCH_STATUS));

export const SLICE5_ALLOWED_ITEM_STATUSES = new Set<string>(Object.values(SLICE5_ITEM_STATUS));


/**
 * @deprecated Prefer `isConflictingActivePayoutItem({ status, execution_status })`.
 * Raw in-flight tokens when `status` is non-terminal. Never apply alone against a
 * COMPLETED/FAILED/CANCELLED row — stale `execution_status=SUBMITTED` must not block.
 */
export const CONFLICTING_ACTIVE_ITEM_STATUSES = new Set<string>([
  ...PAYOUT_ITEM_IN_FLIGHT_STATUSES,
  "pending",
  "processing",
]);


/** Reject active Monday hardcodes in scheduler labels / kinds. */
export function assertNoActiveMondayHardcode(text: string): boolean {
  const s = text.toLowerCase();
  if (s.includes("weekly_monday") || s.includes("weekly-monday")) return false;
  if (s === "monday" || s.includes("hardcoded monday")) return false;
  return true;
}


export function adminBatchStatusLabel(status: string): string {
  if (status === SLICE5_BATCH_STATUS.FUNDS_RESERVED_EXECUTION_DISABLED) {
    return ADMIN_FUNDS_RESERVED_LABEL;
  }
  if (status === SLICE5_BATCH_STATUS.BLOCKED_EXECUTION_DISABLED) {
    return ADMIN_EXECUTION_DISABLED_LABEL;
  }
  return status;
}


export function sumEligibleAmounts(
  items: Array<{ amount_pence: number }>,
): number {
  return items.reduce((s, i) => s + Math.max(0, Math.round(Number(i.amount_pence ?? 0))), 0);
}
