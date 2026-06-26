/** Driver wallet settlement SSOT — ONECAB executes Instant Payout only. */

export const ONECAB_CASHOUT_FEE_PENCE = 100;
export const STRIPE_PAYOUT_METHOD = "instant" as const;

export function isStripeConnectBalanceKnown(
  connectAvailableBalancePence: number | null | undefined,
): boolean {
  return typeof connectAvailableBalancePence === "number" && Number.isFinite(connectAvailableBalancePence);
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
