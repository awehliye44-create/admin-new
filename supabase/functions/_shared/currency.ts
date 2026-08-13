/**
 * SHARED: Region-based currency resolution for Edge Functions.
 * Region is the ONLY source of truth for currency — no hardcoded fallbacks.
 */

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: '£', USD: '$', EUR: '€', INR: '₹', AED: 'د.إ',
  CAD: 'C$', AUD: 'A$', KES: 'KSh', NGN: '₦', ZAR: 'R',
  PKR: '₨', BDT: '৳',
};

export function getCurrencySymbol(code: string | null | undefined): string {
  if (!code) return '';
  return CURRENCY_SYMBOLS[code.toUpperCase()] || '';
}

/**
 * Format pence as a human-readable currency string using Region currency.
 * Returns raw number if currency code unknown.
 */
export function formatPenceWithCurrency(pence: number, currencyCode: string | null | undefined): string {
  const symbol = getCurrencySymbol(currencyCode);
  const amount = Math.abs(pence) / 100;
  const sign = pence < 0 ? '-' : '';
  return `${sign}${symbol}${amount.toFixed(2)}`;
}

/**
 * Format pence with sign (+/-) for ledger display.
 */
export function formatPenceSigned(pence: number, currencyCode: string | null | undefined): string {
  const symbol = getCurrencySymbol(currencyCode);
  const amount = Math.abs(pence) / 100;
  const sign = pence < 0 ? '-' : '+';
  return `${sign}${symbol}${amount.toFixed(2)}`;
}

/**
 * Resolve a driver's Region currency code from the DB.
 * Returns null if no region or no currency configured — callers must handle gracefully.
 */
export async function resolveDriverCurrency(
  supabase: any,
  driverId: string,
): Promise<string | null> {
  const { data: driver } = await supabase
    .from('drivers')
    .select('region_id')
    .eq('id', driverId)
    .single();

  if (!driver?.region_id) return null;

  const { data: region } = await supabase
    .from('regions')
    .select('currency_code')
    .eq('id', driver.region_id)
    .single();

  return region?.currency_code || null;
}

/**
 * Resolve currency from a driver's region_id (when you already have region_id).
 */
export async function resolveRegionCurrency(
  supabase: any,
  regionId: string | null,
): Promise<string | null> {
  if (!regionId) return null;

  const { data: region } = await supabase
    .from('regions')
    .select('currency_code')
    .eq('id', regionId)
    .single();

  return region?.currency_code || null;
}
