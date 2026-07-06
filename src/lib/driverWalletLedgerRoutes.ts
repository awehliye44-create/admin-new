export type DriverWalletLedgerTab = 'overview' | 'payouts' | 'ledger';

/** @deprecated Legacy tab slugs */
export type DriverWalletLedgerLegacyTab =
  | 'accounting'
  | 'history'
  | 'connect-balance'
  | 'stripe';

const LEGACY_TAB_ALIASES: Record<string, DriverWalletLedgerTab> = {
  accounting: 'overview',
  history: 'ledger',
  'connect-balance': 'overview',
  stripe: 'overview',
};

export function parseDriverWalletLedgerTab(value: string | null): DriverWalletLedgerTab {
  if (value === 'overview' || value === 'payouts' || value === 'ledger') {
    return value;
  }
  if (value && LEGACY_TAB_ALIASES[value]) {
    return LEGACY_TAB_ALIASES[value];
  }
  return 'overview';
}

export function driverWalletLedgerUrl(
  driverId: string,
  tab: DriverWalletLedgerTab = 'overview',
): string {
  const params = new URLSearchParams({ driverId, tab });
  return `/driver-wallet-ledger?${params.toString()}`;
}

/** Map audit log ledger type codes to finance-facing labels. */
export function ledgerAuditTypeLabel(rawType: string): string {
  const type = rawType.toUpperCase();
  if (type.includes('TRIP') && (type.includes('EARN') || type.includes('NET') || type.includes('SETTLE'))) {
    return 'Trip Settlement';
  }
  if (type.includes('TRANSFER') || type === 'STRIPE_TRANSFER' || type === 'CONNECT_TRANSFER') {
    return 'Provider Transfer';
  }
  if (type.includes('PAYOUT') || type === 'WEEKLY_PAYOUT' || type === 'EARLY_CASHOUT') {
    return 'Provider Payout';
  }
  if (type.includes('ADJUST')) return 'Adjustment';
  if (type.includes('REFUND')) return 'Refund';
  if (type.includes('CORRECT') || type.includes('ADMIN')) return 'Admin Correction';
  if (type.includes('COMMISSION') || type.includes('DEBT') || type.includes('RECOVERY')) {
    return 'Adjustment';
  }
  return rawType.replace(/_/g, ' ');
}
