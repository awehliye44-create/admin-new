export type ResolvePayoutTransferAmountInput = {
  available_balance_pence: number;
  requested_pence?: number | null;
  min_payout_pence?: number | null;
  max_automatic_pence?: number | null;
};

/**
 * Consume-only payout amount resolver.
 * It never recalculates wallet earnings; it only caps an optional request by
 * Driver Wallet Ledger available balance and policy limits.
 */
export function resolvePayoutTransferAmountPence(input: ResolvePayoutTransferAmountInput): number {
  const available = Math.max(0, Math.round(Number(input.available_balance_pence ?? 0)));
  const requested = input.requested_pence == null
    ? available
    : Math.max(0, Math.round(Number(input.requested_pence)));
  let amount = Math.min(requested, available);

  if (input.max_automatic_pence != null) {
    amount = Math.min(amount, Math.max(0, Math.round(Number(input.max_automatic_pence))));
  }

  const min = Math.max(0, Math.round(Number(input.min_payout_pence ?? 0)));
  return amount >= min ? amount : 0;
}
