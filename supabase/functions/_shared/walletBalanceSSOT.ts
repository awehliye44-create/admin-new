/**
 * Wallet balance SSOT — aligned with Phase 3A.4 computeLedgerWalletBalancePence().
 */
import {
  BALANCE_EXCLUDED_LEDGER_TYPES,
  computeLedgerWalletBalancePence,
  type LedgerRow,
} from "./onecabFinanceLedger.ts";

export { BALANCE_EXCLUDED_LEDGER_TYPES, computeLedgerWalletBalancePence };

/** Reporting-only types excluded from wallet balance (same as BALANCE_EXCLUDED_LEDGER_TYPES). */
export const WALLET_BALANCE_EXCLUDED_LEDGER_TYPES = new Set<string>(
  BALANCE_EXCLUDED_LEDGER_TYPES,
);

export type WalletBalanceLedgerRow = {
  driver_id?: string | null;
  type?: string | null;
  amount_pence?: number | null;
};

export function isWalletBalanceLedgerType(type: string | null | undefined): boolean {
  return !WALLET_BALANCE_EXCLUDED_LEDGER_TYPES.has(String(type ?? ""));
}

/** Ledger wallet balance — identical to computeLedgerWalletBalancePence / perDriverLedgerLiabilityPence (pre-max). */
export function sumLedgerWalletBalancePence(rows: WalletBalanceLedgerRow[]): number {
  const ledger: LedgerRow[] = rows.map((r) => ({
    type: String(r.type ?? ""),
    amount_pence: Number(r.amount_pence ?? 0),
  }));
  return computeLedgerWalletBalancePence(ledger);
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
