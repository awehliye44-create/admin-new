export type DriverWalletLedgerTab = 'overview' | 'ledger' | 'payouts' | 'stripe' | 'history';

export function driverWalletLedgerUrl(
  driverId: string,
  tab: DriverWalletLedgerTab = 'overview',
): string {
  const params = new URLSearchParams({ driverId, tab });
  return `/driver-wallet-ledger?${params.toString()}`;
}
