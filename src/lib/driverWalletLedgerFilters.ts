import type { AdminFinanceLedgerFilter } from '@/lib/adminFinanceLedgerDisplay';

/** Driver Wallet Ledger tab filters — SSOT labels only on this page. */
export type DriverWalletLedgerFilter =
  | 'driver_earnings'
  | 'onecab_commission'
  | 'debt_recovery'
  | 'bonus'
  | 'adjustments'
  | 'refunds'
  | 'payouts';

export const DRIVER_WALLET_LEDGER_FILTER_LABELS: Record<DriverWalletLedgerFilter, string> = {
  driver_earnings: 'Trip Credit',
  onecab_commission: 'Commission',
  debt_recovery: 'Debt Recovery',
  bonus: 'Bonus / Promotion',
  adjustments: 'Adjustments',
  refunds: 'Refund / Chargeback',
  payouts: 'Payout',
};

export function driverWalletFilterToAdminFilter(
  filter: DriverWalletLedgerFilter,
): AdminFinanceLedgerFilter {
  return filter;
}
