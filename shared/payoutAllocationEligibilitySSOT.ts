export const PAYOUT_ALLOCATION_EXCLUDED_PREFIXES = [
  "PLATFORM_COMMISSION",
  "PAYMENT_PROVIDER_FEE",
] as const;

export const PAYOUT_ALLOCATION_EXCLUDED_TYPES = new Set([
  "COMPANY_COMMISSION",
  "COMMISSION_REVERSAL",
  "PROVIDER_FEE_REVERSAL",
]);

export const PAYOUT_ALLOCATION_ELIGIBLE_CREDIT_TYPES = new Set([
  "TRIP_EARNING_NET",
  "TRIP_CREDIT",
  "CASH_TRIP_EARNING",
  "BONUS",
  "PROMOTION",
  "MANUAL_CREDIT",
  "ADJUSTMENT",
  "DRIVER_TIP_CREDIT",
]);

export type PayoutAllocation = {
  amount_pence: number;
};

export type PayoutEligibilityGateInput = {
  amount_pence: number;
  available_balance_pence: number;
  /**
   * True when a payout destination is ready (manual bank / Revolut Business
   * OR Stripe Connect). Not Stripe-Connect-only.
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

export function isAllocatableWalletLedgerType(type: unknown): boolean {
  const normalized = String(type ?? "").trim().toUpperCase();
  if (!normalized) return false;
  if (PAYOUT_ALLOCATION_EXCLUDED_TYPES.has(normalized)) return false;
  if (PAYOUT_ALLOCATION_EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  return PAYOUT_ALLOCATION_ELIGIBLE_CREDIT_TYPES.has(normalized);
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

export function evaluatePayoutEligibilityGate(
  input: PayoutEligibilityGateInput,
): PayoutEligibilityGateResult {
  const reasons: string[] = [];
  const amount = Math.round(Number(input.amount_pence ?? 0));
  const available = Math.round(Number(input.available_balance_pence ?? 0));
  const min = Math.max(0, Math.round(Number(input.min_threshold_pence ?? 0)));
  const currency = String(input.currency ?? "").trim().toUpperCase();
  const expected = String(input.expected_currency ?? "GBP").trim().toUpperCase();

  const destinationReady = input.payout_destination_ready == null
    ? Boolean(input.connected_account)
    : Boolean(input.payout_destination_ready);

  if (amount <= 0) reasons.push("AMOUNT_NOT_POSITIVE");
  if (amount > available) reasons.push("AMOUNT_EXCEEDS_AVAILABLE_BALANCE");
  if (!destinationReady) reasons.push("PAYOUT_DESTINATION_REQUIRED");
  if (input.payouts_paused === true) reasons.push("PAYOUTS_PAUSED");
  if (amount > 0 && amount < min) reasons.push("BELOW_MIN_PAYOUT");
  if (!currency || currency !== expected) reasons.push("CURRENCY_MISMATCH");
  if (!String(input.idempotency_key ?? "").trim()) reasons.push("IDEMPOTENCY_KEY_REQUIRED");

  return {
    ok: reasons.length === 0,
    hold_status: reasons.length > 0 ? "ELIGIBILITY_HOLD" : null,
    reasons,
  };
}
