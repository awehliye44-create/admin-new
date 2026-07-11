import type { AdminFinanceLedgerFilter } from '@/lib/adminFinanceLedgerDisplay';

/** Driver Wallet Ledger tab filters — driver money only (no ONECAB commission). */
export type DriverWalletLedgerFilter =
  | 'all'
  | 'driver_earnings'
  | 'debt_recovery'
  | 'bonus'
  | 'adjustments'
  | 'refunds'
  | 'payouts';

export const DRIVER_WALLET_LEDGER_FILTER_LABELS: Record<DriverWalletLedgerFilter, string> = {
  all: 'All',
  driver_earnings: 'Trip Earnings',
  debt_recovery: 'Debt Recovery',
  bonus: 'Bonus / Promotion',
  adjustments: 'Wallet Adjustment',
  refunds: 'Refund / Chargeback',
  payouts: 'Payout',
};

export function driverWalletFilterToAdminFilter(
  filter: DriverWalletLedgerFilter,
): AdminFinanceLedgerFilter {
  return filter;
}
