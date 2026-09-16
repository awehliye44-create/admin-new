/** Driver wallet display amount / history window helpers. */

export function driverWalletDisplayAmountPence(amountPence: number | null | undefined): number {
  return Math.trunc(Number(amountPence) || 0);
}

export function driverWalletTransactionIsCredit(amountPence: number | null | undefined): boolean {
  return driverWalletDisplayAmountPence(amountPence) > 0;
}

export function isDriverWalletHiddenLedgerType(type: string | null | undefined): boolean {
  const t = String(type ?? "").toLowerCase();
  return t.includes("processing") || t.includes("fee_internal") || t.includes("connect");
}

export function walletTabHistoryWeeks(): number {
  return 12;
}

export function walletTransactionHistoryCutoffIso(nowMs = Date.now()): string {
  const weeks = walletTabHistoryWeeks();
  return new Date(nowMs - weeks * 7 * 24 * 60 * 60 * 1000).toISOString();
}
