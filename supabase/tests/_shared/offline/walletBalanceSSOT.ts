/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Wallet balance SSOT — aligned with Phase 3A.4 computeLedgerWalletBalancePence().
 */
import {
  BALANCE_EXCLUDED_LEDGER_TYPES,
  computeLedgerWalletBalancePence,
  type LedgerRow,
} from "../../../functions/_shared/onecabFinanceLedger.ts";
import { WalletBalanceLedgerRow } from "../../../functions/_shared/walletBalanceSSOT.ts";


/** Ledger wallet balance — identical to computeLedgerWalletBalancePence / perDriverLedgerLiabilityPence (pre-max). */
export function sumLedgerWalletBalancePence(rows: WalletBalanceLedgerRow[]): number {
  const ledger: LedgerRow[] = rows.map((r) => ({
    type: String(r.type ?? ""),
    amount_pence: Number(r.amount_pence ?? 0),
  }));
  return computeLedgerWalletBalancePence(ledger);
}

export * from "../../../functions/_shared/walletBalanceSSOT.ts";
