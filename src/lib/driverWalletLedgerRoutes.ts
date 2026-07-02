export type DriverWalletLedgerTab = 'overview' | 'accounting' | 'ledger';

/** @deprecated Legacy tab slugs — mapped in parseDriverWalletLedgerTab */
export type DriverWalletLedgerLegacyTab =
  | 'payouts'
  | 'stripe'
  | 'history'
  | 'connect-balance';

const LEGACY_TAB_ALIASES: Record<string, DriverWalletLedgerTab> = {
  payouts: 'accounting',
  stripe: 'accounting',
  history: 'ledger',
  'connect-balance': 'accounting',
};

export function parseDriverWalletLedgerTab(value: string | null): DriverWalletLedgerTab {
  if (value === 'overview' || value === 'accounting' || value === 'ledger') {
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
    return 'Stripe Transfer';
  }
  if (type.includes('PAYOUT') || type === 'WEEKLY_PAYOUT' || type === 'EARLY_CASHOUT') {
    return 'Stripe Payout';
  }
  if (type.includes('ADJUST')) return 'Adjustment';
  if (type.includes('REFUND')) return 'Refund';
  if (type.includes('CORRECT') || type.includes('ADMIN')) return 'Admin Correction';
  if (type.includes('COMMISSION') || type.includes('DEBT') || type.includes('RECOVERY')) {
    return 'Adjustment';
  }
  return rawType.replace(/_/g, ' ');
}
