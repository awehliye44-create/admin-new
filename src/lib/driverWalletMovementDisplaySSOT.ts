/**
 * Driver Wallet Ledger display SSOT — which ledger types affect driver money.
 * PLATFORM_COMMISSION / provider fees belong to Financial Reconciliation, not this ledger UI.
 */

/** Types that must never appear in Driver Wallet Transactions. */
export const DRIVER_WALLET_EXCLUDED_LEDGER_TYPES = [
  'PLATFORM_COMMISSION',
  'PLATFORM_COMMISSION_GROSS',
  'PLATFORM_COMMISSION_NET',
  'COMPANY_COMMISSION',
  'PAYMENT_PROVIDER_FEE',
  'PAYMENT_PROVIDER_FEE_ADJUSTMENT',
  'PROVIDER_FEE_REVERSAL',
  'COMMISSION_REVERSAL',
] as const;

const EXCLUDED = new Set<string>(DRIVER_WALLET_EXCLUDED_LEDGER_TYPES);

/**
 * True when the row is a driver-wallet movement (earnings, bonus, adjustment,
 * debt recovery, refund/chargeback, payout, manual credit/debit, reversals that restore wallet).
 */
export function isDriverWalletMovementLedgerType(type: string | null | undefined): boolean {
  const t = String(type ?? '').toUpperCase();
  if (!t) return false;
  if (EXCLUDED.has(t)) return false;
  // Legacy ONECAB commission credits must not appear even under alternate names.
  if (t.includes('PLATFORM_COMMISSION') || t.includes('PROVIDER_FEE')) return false;
  if (t === 'COMPANY_COMMISSION') return false;
  return true;
}

/** Filter ledger rows for Driver Wallet Transactions display. */
export function filterDriverWalletMovementRows<T extends { type: string }>(rows: T[]): T[] {
  return rows.filter((r) => isDriverWalletMovementLedgerType(r.type));
}
