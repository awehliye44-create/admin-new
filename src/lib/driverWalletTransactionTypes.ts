/**
 * Map raw ledger type codes to Driver Wallet Ledger transaction type enums.
 * Display-only — does not invent amounts.
 * PLATFORM_COMMISSION is not a wallet display type (FR owns commission).
 * DRIVER_TIP_CREDIT stays its own type — never fold into TRIP_EARNING.
 */
export const DRIVER_WALLET_TX_TYPES = [
  'TRIP_EARNING',
  'DRIVER_TIP_CREDIT',
  'BONUS',
  'ADJUSTMENT',
  'MANUAL_CREDIT',
  'MANUAL_DEBIT',
  'PAYOUT',
  'DEBT_RECOVERY',
  'REVERSAL',
  'REFUND',
] as const;

export type DriverWalletTxType = (typeof DRIVER_WALLET_TX_TYPES)[number];

export function canonicalDriverWalletTxType(rawType: string | null | undefined): DriverWalletTxType | string {
  const type = String(rawType ?? '').toUpperCase();
  if (!type) return 'ADJUSTMENT';

  if (type === 'MANUAL_CREDIT') return 'MANUAL_CREDIT';
  if (type === 'MANUAL_DEBIT') return 'MANUAL_DEBIT';
  if (type === 'ADMIN_WALLET_CREDIT') return 'MANUAL_CREDIT';
  if (type === 'ADMIN_WALLET_DEBIT') return 'MANUAL_DEBIT';
  if (type === 'BONUS' || type === 'PROMOTION' || type === 'INCENTIVE') return 'BONUS';
  if (type === 'ADJUSTMENT' || type === 'MANUAL_ADJUSTMENT' || type === 'CORRECTION' || type === 'ADMIN_CORRECTION') {
    return 'ADJUSTMENT';
  }
  if (
    type === 'DEBT_RECOVERY'
    || type === 'COMMISSION_RECOVERED'
    || type === 'CASH_COMMISSION_DEBT'
  ) {
    return 'DEBT_RECOVERY';
  }
  if (type.includes('REFUND') || type === 'CHARGEBACK_DEBIT') return 'REFUND';
  if (type.includes('REVERSAL') || type === 'LEDGER_REVERSAL' || type === 'PAYOUT_FAILED_RETURN') {
    return 'REVERSAL';
  }
  if (
    type.includes('PAYOUT')
    || type === 'EARLY_CASHOUT'
    || type === 'CASHOUT_FEE'
  ) {
    return 'PAYOUT';
  }
  // Tips stay distinct — never fold DRIVER_TIP_CREDIT into TRIP_EARNING.
  if (type === 'DRIVER_TIP_CREDIT' || type === 'TIP_CREDIT') {
    return 'DRIVER_TIP_CREDIT';
  }
  if (
    type.includes('TRIP')
    || type === 'DRIVER_EARNING'
    || type === 'TRIP_EARNING_NET'
    || type === 'TRIP_CREDIT'
    || type === 'CASH_TRIP_EARNING'
  ) {
    return 'TRIP_EARNING';
  }
  return type;
}

/** Human label for wallet timeline / filters — tip stays Tip, not Trip earning. */
export function driverWalletTxTypeLabel(rawType: string | null | undefined): string {
  const canonical = canonicalDriverWalletTxType(rawType);
  if (canonical === 'DRIVER_TIP_CREDIT') return 'Tip';
  if (canonical === 'TRIP_EARNING') return 'Trip earning';
  if (canonical === 'BONUS') return 'Bonus';
  if (canonical === 'ADJUSTMENT') return 'Adjustment';
  if (canonical === 'MANUAL_CREDIT') return 'Manual credit';
  if (canonical === 'MANUAL_DEBIT') return 'Manual debit';
  if (canonical === 'PAYOUT') return 'Payout';
  if (canonical === 'DEBT_RECOVERY') return 'Debt recovery';
  if (canonical === 'REVERSAL') return 'Reversal';
  if (canonical === 'REFUND') return 'Refund';
  return String(rawType ?? 'Adjustment');
}
