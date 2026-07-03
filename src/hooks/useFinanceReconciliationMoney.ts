import { useMemo } from 'react';
import type { FinanceReconciliationResponse } from '@/hooks/useFinanceReconciliation';
import {
  formatMoneyMinor,
  formatWithFinanceCurrencyMeta,
  getCurrencyMinorUnit,
  type FinanceCurrencyMeta,
} from '@/lib/formatMoneyMinor';

export type FinanceMoneyFormat = {
  currencyCode: string | null;
  currencySymbol: string | null;
  currencyMinorUnit: number;
  isMixedCurrency: boolean;
  /** Format amount using page scope currency (or trip override). */
  fmt: (amountMinor: number | null | undefined, tripCurrencyCode?: string | null) => string;
  /** Label for platform Stripe balance — always platform account currency. */
  fmtPlatformStripe: (amountMinor: number | null | undefined, platformCurrency?: string | null) => string;
};

function pickCurrencyMeta(
  response: FinanceReconciliationResponse | null | undefined,
): FinanceCurrencyMeta | null {
  if (!response) return null;
  const code = response.currency_code;
  if (!code) return null;
  return {
    currency_code: code,
    currency_symbol: response.currency_symbol ?? code,
    currency_minor_unit: response.currency_minor_unit ?? getCurrencyMinorUnit(code),
    region_id: response.region_id ?? null,
    service_area_id: response.service_area_id ?? null,
    is_mixed_currency_scope: response.is_mixed_currency_scope === true,
  };
}

export function useFinanceReconciliationMoney(
  response: FinanceReconciliationResponse | null | undefined,
  filterCurrencyCode?: string | null,
): FinanceMoneyFormat {
  return useMemo(() => {
    const meta = pickCurrencyMeta(response);
    const currencyCode = meta?.currency_code ?? filterCurrencyCode ?? null;
    const currencyMinorUnit = meta?.currency_minor_unit ?? getCurrencyMinorUnit(currencyCode);
    const isMixedCurrency = meta?.is_mixed_currency_scope === true;

    const fmt = (amountMinor: number | null | undefined, tripCurrencyCode?: string | null) => {
      if (isMixedCurrency && !tripCurrencyCode) return '—';
      return formatWithFinanceCurrencyMeta(amountMinor, meta, tripCurrencyCode ?? filterCurrencyCode);
    };

    const fmtPlatformStripe = (
      amountMinor: number | null | undefined,
      platformCurrency?: string | null,
    ) => {
      const code = platformCurrency ?? meta?.currency_code ?? filterCurrencyCode;
      if (!code || amountMinor == null) return '—';
      return formatMoneyMinor(amountMinor, code, 'en-GB', getCurrencyMinorUnit(code));
    };

    return {
      currencyCode,
      currencySymbol: meta?.currency_symbol ?? null,
      currencyMinorUnit,
      isMixedCurrency,
      fmt,
      fmtPlatformStripe,
    };
  }, [response, filterCurrencyCode]);
}
