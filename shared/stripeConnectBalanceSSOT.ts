/**
 * Stripe Connect balance SSOT — driver-facing "Available in Stripe".
 *
 * Authoritative source: Stripe API balance.retrieve({ stripeAccount }).
 * Use balance.available for standard payouts / weekly transfer cap.
 * instant_available is diagnostic + instant cash-out only — never driver card display.
 * pending is diagnostic only — not payable yet.
 */

export const STRIPE_BALANCE_SSOT_SOURCE = 'stripe_api_balance_available' as const;

export type StripeConnectBalanceDiagnostic = {
  /** balance.available (region currency) — driver + weekly transfer cap SSOT */
  stripe_available_pence: number | null;
  /** balance.pending — admin diagnostic only */
  stripe_pending_pence: number | null;
  /** balance.instant_available — admin diagnostic + instant cash-out only */
  stripe_instant_available_pence: number | null;
  stripe_balance_last_synced_at: string | null;
  stripe_balance_source: typeof STRIPE_BALANCE_SSOT_SOURCE | null;
};

type StripeBalanceRow = { currency: string; amount: number };

function sumByCurrency(
  rows: StripeBalanceRow[] | undefined,
  currency: string,
): number {
  const ccy = currency.toLowerCase();
  return (rows ?? [])
    .filter((row) => row.currency === ccy)
    .reduce((sum, row) => sum + Math.max(0, Math.round(row.amount)), 0);
}

/** Driver-facing Stripe available — SUM(balance.available where currency = region currency). */
export function sumStripeBalanceAvailablePence(
  balance: { available?: StripeBalanceRow[] },
  currency: string,
): number {
  return sumByCurrency(balance.available, currency);
}

export function sumStripeBalancePendingPence(
  balance: { pending?: StripeBalanceRow[] },
  currency: string,
): number {
  return sumByCurrency(balance.pending, currency);
}

export function sumStripeBalanceInstantAvailablePence(
  balance: { instant_available?: StripeBalanceRow[] },
  currency: string,
): number {
  return sumByCurrency(balance.instant_available, currency);
}

export function buildStripeConnectBalanceDiagnostic(args: {
  available_pence: number | null;
  pending_pence: number | null;
  instant_available_pence: number | null;
  synced_at: string | null;
  known: boolean;
}): StripeConnectBalanceDiagnostic {
  if (!args.known) {
    return {
      stripe_available_pence: null,
      stripe_pending_pence: null,
      stripe_instant_available_pence: null,
      stripe_balance_last_synced_at: null,
      stripe_balance_source: null,
    };
  }
  return {
    stripe_available_pence: args.available_pence,
    stripe_pending_pence: args.pending_pence,
    stripe_instant_available_pence: args.instant_available_pence,
    stripe_balance_last_synced_at: args.synced_at,
    stripe_balance_source: STRIPE_BALANCE_SSOT_SOURCE,
  };
}
