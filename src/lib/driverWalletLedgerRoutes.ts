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
  const exact: Record<string, string> = {
    TRIP_EARNING_NET: 'Trip Credit',
    TRIP_CREDIT: 'Trip Credit',
    CASH_TRIP_EARNING: 'Trip Credit',
    PLATFORM_COMMISSION: 'Commission',
    COMPANY_COMMISSION: 'Commission',
    CASH_COMMISSION_DEBT: 'Commission',
    BONUS: 'Bonus',
    PROMOTION: 'Promotion',
    ADJUSTMENT: 'Adjustment',
    MANUAL_ADJUSTMENT: 'Adjustment',
    MANUAL_CREDIT: 'Manual Credit',
    MANUAL_DEBIT: 'Manual Debit',
    REFUND_DEBIT: 'Refund',
    CHARGEBACK_DEBIT: 'Chargeback',
    DEBT_RECOVERY: 'Debt Recovery',
    COMMISSION_RECOVERED: 'Debt Recovery',
    WEEKLY_PAYOUT: 'Payout',
    EARLY_CASHOUT: 'Payout',
    MANUAL_PAYOUT: 'Payout',
    PAYOUT: 'Payout',
    PAYOUT_CREATED: 'Payout',
    CASHOUT_FEE: 'Payout',
    PAYOUT_FAILED_RETURN: 'Payout Reversal',
    PAYOUT_REVERSAL: 'Payout Reversal',
    CORRECTION: 'Correction',
    LEDGER_REVERSAL: 'Correction',
  };
  if (exact[type]) return exact[type];
  if (type.includes('TRIP') && (type.includes('EARN') || type.includes('NET') || type.includes('SETTLE'))) {
    return 'Trip Credit';
  }
  if (type.includes('PAYOUT') || type === 'EARLY_CASHOUT') return 'Payout';
  if (type.includes('ADJUST')) return 'Adjustment';
  if (type.includes('REFUND')) return 'Refund';
  if (type.includes('CHARGEBACK')) return 'Chargeback';
  if (type.includes('CORRECT')) return 'Correction';
  if (type.includes('BONUS')) return 'Bonus';
  if (type.includes('PROMOTION')) return 'Promotion';
  if (type.includes('COMMISSION') || type.includes('DEBT') || type.includes('RECOVERY')) {
    return type.includes('DEBT') || type.includes('RECOVERY') ? 'Debt Recovery' : 'Commission';
  }
  return rawType.replace(/_/g, ' ');
}
