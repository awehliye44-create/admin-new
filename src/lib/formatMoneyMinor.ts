import { getCurrencySymbol } from '@/lib/regionSettings';

/** ISO 4217 zero-decimal currencies (Provider-aligned subset). */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG',
  'RWF', 'SOS', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

export function getCurrencyMinorUnit(currencyCode: string | null | undefined): number {
  const code = String(currencyCode ?? '').toUpperCase();
  if (!code) return 2;
  return ZERO_DECIMAL_CURRENCIES.has(code) ? 0 : 2;
}

/**
 * Format minor-unit money using region operational currency — never browser locale default.
 */
export function formatMoneyMinor(
  amountMinor: number,
  currencyCode: string,
  locale = 'en-GB',
  minorUnit?: number,
): string {
  if (!currencyCode) return '—';
  const unit = minorUnit ?? getCurrencyMinorUnit(currencyCode);
  const symbol = getCurrencySymbol(currencyCode);
  const divisor = Math.pow(10, unit);
  const major = amountMinor / divisor;

  if (unit === 0) {
    const formatted = Math.abs(Math.round(major)).toLocaleString(locale);
    return amountMinor < 0 ? `-${symbol}${formatted}` : `${symbol}${formatted}`;
  }

  const formatted = Math.abs(major).toFixed(unit);
  return amountMinor < 0 ? `-${symbol}${formatted}` : `${symbol}${formatted}`;
}

/** @deprecated Prefer formatMoneyMinor — kept for gradual migration. */
export function formatPenceFromMinor(
  pence: number,
  currencyCode: string,
  minorUnit?: number,
): string {
  return formatMoneyMinor(pence, currencyCode, 'en-GB', minorUnit);
}

export type FinanceCurrencyMeta = {
  currency_code: string;
  currency_symbol: string;
  currency_minor_unit: number;
  region_id: string | null;
  service_area_id: string | null;
  is_mixed_currency_scope: boolean;
};

export type FinanceCurrencyGroupTotals = {
  currency_code: string;
  currency_symbol: string;
  currency_minor_unit: number;
  customer_revenue_pence: number;
  driver_net_pence: number;
  commission_pence: number;
  trip_count: number;
};

export function formatWithFinanceCurrencyMeta(
  amountMinor: number | null | undefined,
  meta: FinanceCurrencyMeta | null | undefined,
  tripCurrencyCode?: string | null,
): string {
  if (amountMinor == null) return '—';
  const code = tripCurrencyCode ?? meta?.currency_code;
  if (!code) return '—';
  if (meta?.is_mixed_currency_scope && !tripCurrencyCode) return '—';
  const minorUnit = tripCurrencyCode
    ? getCurrencyMinorUnit(tripCurrencyCode)
    : meta?.currency_minor_unit;
  return formatMoneyMinor(amountMinor, code, 'en-GB', minorUnit);
}
