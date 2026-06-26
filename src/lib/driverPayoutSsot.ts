/**
 * Driver payout SSOT — ONECAB executes Instant Payout only.
 *
 * Display: show Stripe Standard Available (balance.available) and Instant Available separately.
 * Execution: cashout_now = min(ledger owed, finance-cleared, Stripe Instant Available)
 * awaiting_settlement = max(0, ledger − Stripe Standard Available)
 */

export const ONECAB_CASHOUT_FEE_PENCE = 100;

export const STRIPE_PAYOUT_METHOD = "instant" as const;

export const PAYOUT_TYPE = {
  WEEKLY_AUTO: "weekly_auto",
  MANUAL_CASHOUT: "manual_cashout",
} as const;

export const MIN_CASHOUT_AMOUNT_PENCE = 500;

export function isStripeConnectBalanceKnown(
  connectAvailableBalancePence: number | null | undefined,
): boolean {
  return typeof connectAvailableBalancePence === 'number' && Number.isFinite(connectAvailableBalancePence);
}

export function computeConnectAwaitingSettlementPence(
  ledgerEarnedPence: number,
  connectAvailableBalancePence: number | null | undefined,
): number | null {
  if (!isStripeConnectBalanceKnown(connectAvailableBalancePence)) return null;
  const ledger = Math.max(0, Math.round(ledgerEarnedPence));
  const connect = Math.max(0, Math.round(connectAvailableBalancePence as number));
  return Math.max(0, ledger - connect);
}

/** Instant execution cap — ONECAB never uses Standard payout method. */
export function computeDriverCashoutExecutablePence(
  ledgerEarnedPence: number,
  financeClearedPence: number,
  connectInstantAvailablePence: number | null | undefined,
): number | null {
  if (!isStripeConnectBalanceKnown(connectInstantAvailablePence)) return null;
  const ledger = Math.max(0, Math.round(ledgerEarnedPence));
  const financeCleared = Math.max(0, Math.round(financeClearedPence));
  const instant = Math.max(0, Math.round(connectInstantAvailablePence as number));
  return Math.min(ledger, financeCleared, instant);
}

export function computeWeeklyInstantEligiblePence(
  ledgerEarnedPence: number,
  financeClearedPence: number,
  connectInstantAvailablePence: number | null | undefined,
): number | null {
  return computeDriverCashoutExecutablePence(
    ledgerEarnedPence,
    financeClearedPence,
    connectInstantAvailablePence,
  );
}

export function computeManualInstantEligiblePence(
  ledgerEarnedPence: number,
  financeClearedPence: number,
  connectInstantAvailablePence: number | null | undefined,
): number | null {
  return computeDriverCashoutExecutablePence(
    ledgerEarnedPence,
    financeClearedPence,
    connectInstantAvailablePence,
  );
}

export function currencySymbolForCode(currencyCode: string): string {
  const c = currencyCode.toLowerCase();
  if (c === 'gbp') return '£';
  if (c === 'eur') return '€';
  if (c === 'usd') return '$';
  return `${currencyCode.toUpperCase()} `;
}

export function formatAdminDriverPayoutSsotSummary(args: {
  walletOwedPence: number;
  connectAvailablePence: number;
  cashoutNowPence: number;
  currencyCode?: string;
}): string {
  const sym = currencySymbolForCode(args.currencyCode ?? 'gbp');
  const owed = `${sym}${(Math.max(0, args.walletOwedPence) / 100).toFixed(2)}`;
  const connect = `${sym}${(Math.max(0, args.connectAvailablePence) / 100).toFixed(2)}`;
  const cashout = `${sym}${(Math.max(0, args.cashoutNowPence) / 100).toFixed(2)}`;
  return `Driver is owed ${owed}. Stripe Connect has ${connect} instantly available. Cash-out available now: ${cashout}.`;
}

export function buildCashoutBlockReasons(args: {
  cashoutNowPence: number | null;
  walletOwedPence: number;
  financeClearedPence: number;
  connectAvailablePence: number;
  payoutsEnabled: boolean;
  payoutBlocked: boolean;
  payoutBlockedReasons: string[];
  manualConnectBlockReasons: string[];
}): string[] {
  const reasons: string[] = [];

  if (args.payoutBlocked && args.payoutBlockedReasons.length > 0) {
    reasons.push(...args.payoutBlockedReasons);
  }
  if (!args.payoutsEnabled) {
    reasons.push('Stripe Connect payouts disabled');
  }
  if (args.walletOwedPence <= 0) {
    reasons.push('ONECAB wallet balance is zero or negative');
  }
  if (args.financeClearedPence <= 0) {
    reasons.push('Finance-cleared amount is zero');
  }
  if (args.connectAvailablePence <= 0) {
    reasons.push('Stripe Connect available balance is zero');
  }
  if (args.cashoutNowPence != null && args.cashoutNowPence > 0 && args.cashoutNowPence < MIN_CASHOUT_AMOUNT_PENCE) {
    reasons.push(`Below minimum cash-out (£${(MIN_CASHOUT_AMOUNT_PENCE / 100).toFixed(2)})`);
  }
  if (args.cashoutNowPence === 0 || args.cashoutNowPence == null) {
    reasons.push(...args.manualConnectBlockReasons.filter(
      (r) => !reasons.includes(r),
    ));
  }

  return [...new Set(reasons)];
}
