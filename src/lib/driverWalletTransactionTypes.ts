/**
 * Map raw ledger type codes to Driver Wallet Ledger transaction type enums.
 * Display-only — does not invent amounts.
 */
export const DRIVER_WALLET_TX_TYPES = [
  'TRIP_EARNING',
  'PLATFORM_COMMISSION',
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
  if (type === 'PLATFORM_COMMISSION' || type === 'COMPANY_COMMISSION' || type === 'CASH_COMMISSION_DEBT') {
    return 'PLATFORM_COMMISSION';
  }
  if (type === 'BONUS' || type === 'PROMOTION' || type === 'INCENTIVE') return 'BONUS';
  if (type === 'ADJUSTMENT' || type === 'MANUAL_ADJUSTMENT' || type === 'CORRECTION' || type === 'ADMIN_CORRECTION') {
    return 'ADJUSTMENT';
  }
  if (
    type === 'DEBT_RECOVERY'
    || type === 'COMMISSION_RECOVERED'
  ) {
    return 'DEBT_RECOVERY';
  }
  if (type.includes('REFUND')) return 'REFUND';
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
