export type DriverWalletLedgerTab =
  | 'overview'
  | 'drivers'
  | 'ledger'
  | 'debt'
  | 'adjustments'
  | 'payout_allocations'
  | 'history'
  /** @deprecated use payout_allocations */
  | 'payouts';

/** @deprecated Legacy tab slugs */
export type DriverWalletLedgerLegacyTab =
  | 'accounting'
  | 'connect-balance'
  | 'stripe';

const LEGACY_TAB_ALIASES: Record<string, DriverWalletLedgerTab> = {
  accounting: 'overview',
  history: 'history',
  'connect-balance': 'overview',
  stripe: 'overview',
  payouts: 'payout_allocations',
  ledger: 'ledger',
};

export function parseDriverWalletLedgerTab(value: string | null): DriverWalletLedgerTab {
  const allowed: DriverWalletLedgerTab[] = [
    'overview',
    'drivers',
    'ledger',
    'debt',
    'adjustments',
    'payout_allocations',
    'history',
    'payouts',
  ];
  if (value && (allowed as string[]).includes(value)) {
    if (value === 'payouts') return 'payout_allocations';
    return value as DriverWalletLedgerTab;
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
