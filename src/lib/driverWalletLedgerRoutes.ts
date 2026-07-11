export type DriverWalletLedgerTab =
  | 'drivers'
  | 'overview'
  | 'settlement'
  | 'transactions'
  | 'debt_recovery'
  | 'statements'
  /** @deprecated bank transfers owned by Payout Ledger — aliases to overview */
  | 'payouts'
  /** @deprecated merged into statements */
  | 'downloads'
  /** @deprecated use transactions */
  | 'ledger'
  /** @deprecated use debt_recovery */
  | 'debt'
  /** @deprecated use transactions */
  | 'adjustments'
  /** @deprecated use overview */
  | 'payout_allocations'
  /** @deprecated use transactions */
  | 'history';

/** @deprecated Legacy tab slugs */
export type DriverWalletLedgerLegacyTab =
  | 'accounting'
  | 'connect-balance'
  | 'stripe';

const LEGACY_TAB_ALIASES: Record<string, DriverWalletLedgerTab> = {
  accounting: 'overview',
  'connect-balance': 'overview',
  stripe: 'overview',
  ledger: 'transactions',
  adjustments: 'transactions',
  history: 'transactions',
  debt: 'debt_recovery',
  payout_allocations: 'overview',
  payouts: 'overview',
  downloads: 'statements',
};

const CANONICAL_TABS: DriverWalletLedgerTab[] = [
  'drivers',
  'overview',
  'settlement',
  'transactions',
  'debt_recovery',
  'statements',
];

export function parseDriverWalletLedgerTab(value: string | null): DriverWalletLedgerTab {
  if (value && (CANONICAL_TABS as string[]).includes(value)) {
    return value as DriverWalletLedgerTab;
  }
  if (value && LEGACY_TAB_ALIASES[value]) {
    return LEGACY_TAB_ALIASES[value];
  }
  return 'drivers';
}

export function driverWalletLedgerUrl(
  driverId: string,
  tab: DriverWalletLedgerTab = 'overview',
): string {
  const canonical = parseDriverWalletLedgerTab(tab);
  const params = new URLSearchParams({ driverId, tab: canonical === 'drivers' ? 'overview' : canonical });
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
