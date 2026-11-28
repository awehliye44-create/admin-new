export const PAYOUT_ALLOCATION_EXCLUDED_PREFIXES = [
  "PLATFORM_COMMISSION",
  "PAYMENT_PROVIDER_FEE",
] as const;

export const PAYOUT_ALLOCATION_EXCLUDED_TYPES = new Set([
  "COMPANY_COMMISSION",
  "COMMISSION_REVERSAL",
  "PROVIDER_FEE_REVERSAL",
]);

/**
 * Payout Ledger may consume only these Driver Wallet Ledger credits.
 * Must stay aligned with PAYOUT_ELIGIBLE_LEDGER_TYPES.
 * CASH_TRIP_EARNING / ADJUSTMENT / ADMIN_WALLET_* are never bank-transfer source rows.
 * BONUS is allocatable (immediate credit; occupancy prevents double pay).
 */
export const PAYOUT_ALLOCATION_ELIGIBLE_CREDIT_TYPES = new Set([
  "TRIP_EARNING_NET",
  "DRIVER_COMPENSATION_CREDIT",
  "DRIVER_TIP_CREDIT",
  "TIP_CREDIT",
  "BONUS",
]);

/** Allocations on these payout items stay on disk (audit) but no longer reserve the ledger. */
export const PAYOUT_ALLOCATION_RELEASED_ITEM_STATUSES = new Set([
  "CANCELLED",
  "RELEASED",
  "INELIGIBLE",
  "FAILED",
  "REVERSED",
  "RETURNED",
  "INVALID_ORPHANED",
  "LEDGER_SYNC_FAILED",
  "FAILED_RETRYABLE",
  "FAILED_PERMANENT",
]);

export type PayoutAllocation = {
  amount_pence: number;
};

export type PayoutEligibilityGateInput = {
  amount_pence: number;
  available_balance_pence: number;
  /**
   * True when a payout destination is ready (manual bank / Revolut Business
   * OR provider Connect). Not provider-Connect-only.
   */
  connected_account: boolean;
  /** @deprecated Prefer connected_account meaning "destination ready". */
  payout_destination_ready?: boolean | null;
  payouts_paused?: boolean | null;
  min_threshold_pence?: number | null;
  currency?: string | null;
  expected_currency?: string | null;
  idempotency_key?: string | null;
};

export type PayoutEligibilityGateResult = {
  ok: boolean;
  hold_status: "ELIGIBILITY_HOLD" | null;
  reasons: string[];
};

export function payoutItemStatusReleasesLedgerAllocation(
  status: unknown,
  executionStatus?: unknown,
): boolean {
  const st = String(status ?? "").trim().toUpperCase();
  const ex = String(executionStatus ?? "").trim().toUpperCase();
  return PAYOUT_ALLOCATION_RELEASED_ITEM_STATUSES.has(st)
    || PAYOUT_ALLOCATION_RELEASED_ITEM_STATUSES.has(ex);
}

export function assertAllocationEqualsAmount(
  allocations: PayoutAllocation[],
  amountPence: number,
): void {
  const total = allocations.reduce((sum, row) => sum + Math.max(0, Math.round(Number(row.amount_pence ?? 0))), 0);
  const expected = Math.max(0, Math.round(Number(amountPence ?? 0)));
  if (total !== expected) {
    throw new Error(`Payout allocation total ${total}p does not equal payout amount ${expected}p`);
  }
}
