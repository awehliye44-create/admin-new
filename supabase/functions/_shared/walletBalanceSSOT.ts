/**
 * Wallet balance SSOT — aligned with Phase 3A.4 computeLedgerWalletBalancePence().
 */
import {
  BALANCE_EXCLUDED_LEDGER_TYPES,
  computeLedgerWalletBalancePence,
  type LedgerRow,
} from "./onecabFinanceLedger.ts";

export { BALANCE_EXCLUDED_LEDGER_TYPES, computeLedgerWalletBalancePence };

/**
 * Ledger types excluded from wallet balance (driver liability calculation).
 * Ownership model: wallet balance should exclude only platform commission and
 * cash-trip earnings; other audit rows are included in driver liability math.
 */
export const WALLET_BALANCE_EXCLUDED_LEDGER_TYPES = new Set<string>([
  "PLATFORM_COMMISSION",
  "CASH_TRIP_EARNING",
  // #98: pending entitlement / release never inflate live wallet liability.
  "TRIP_EARNING_PENDING",
  "TRIP_EARNING_PENDING_RELEASE",
]);

export type WalletBalanceLedgerRow = {
  driver_id?: string | null;
  type?: string | null;
  amount_pence?: number | null;
};

export function isWalletBalanceLedgerType(type: string | null | undefined): boolean {
  return !WALLET_BALANCE_EXCLUDED_LEDGER_TYPES.has(String(type ?? ""));
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
