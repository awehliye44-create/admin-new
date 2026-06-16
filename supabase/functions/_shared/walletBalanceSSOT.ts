/**
 * Wallet balance SSOT — mirrors driver_financial_summary.balance_totals and onecabFinanceLedger.
 */

export const WALLET_BALANCE_EXCLUDED_LEDGER_TYPES = new Set([
  "PLATFORM_COMMISSION",
  "CASH_TRIP_EARNING",
  "COMMISSION_RECOVERED",
]);

export type WalletBalanceLedgerRow = {
  driver_id?: string | null;
  type?: string | null;
  amount_pence?: number | null;
};

export function isWalletBalanceLedgerType(type: string | null | undefined): boolean {
  return !WALLET_BALANCE_EXCLUDED_LEDGER_TYPES.has(String(type ?? ""));
}

export function sumLedgerWalletBalancePence(rows: WalletBalanceLedgerRow[]): number {
  let sum = 0;
  for (const row of rows) {
    if (!isWalletBalanceLedgerType(row.type)) continue;
    sum += Number(row.amount_pence ?? 0);
  }
  return sum;
}

export function sumLedgerWalletBalanceByDriver(
  rows: WalletBalanceLedgerRow[],
): Map<string, number> {
  const byDriver = new Map<string, number>();
  for (const row of rows) {
    if (!row.driver_id || !isWalletBalanceLedgerType(row.type)) continue;
    byDriver.set(
      row.driver_id,
      (byDriver.get(row.driver_id) ?? 0) + Number(row.amount_pence ?? 0),
    );
  }
  return byDriver;
}
