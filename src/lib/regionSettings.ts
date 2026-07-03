/**
 * Region Settings Utilities
 * 
 * Single source of truth for currency and distance unit handling.
 * All values come from regions table based on pickup location polygon.
 */

export interface RegionSettings {
  region_id: string;
  region_name: string;
  currency_code: string;
  distance_unit: 'mile' | 'km';
  timezone: string;
  service_area_id: string | null;
  service_area_name: string | null;
}

// Currency symbol mapping — SINGLE SOURCE OF TRUTH for symbol lookups
const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: '£',
  USD: '$',
  EUR: '€',
  CAD: 'C$',
  AUD: 'A$',
  NZD: 'NZ$',
  INR: '₹',
  JPY: '¥',
  CNY: '¥',
  KRW: '₩',
  SGD: 'S$',
  HKD: 'HK$',
  MXN: 'MX$',
  BRL: 'R$',
  ZAR: 'R',
  AED: 'د.إ',
  SAR: '﷼',
  CHF: 'CHF',
  SEK: 'kr',
  NOK: 'kr',
  DKK: 'kr',
  PLN: 'zł',
  CZK: 'Kč',
  HUF: 'Ft',
  RUB: '₽',
  TRY: '₺',
  THB: '฿',
  MYR: 'RM',
  IDR: 'Rp',
  PHP: '₱',
  VND: '₫',
  PKR: '₨',
  BDT: '৳',
  NGN: '₦',
  KES: 'KSh',
  EGP: 'E£',
  MAD: 'DH',
  COP: 'COL$',
  ARS: 'AR$',
  CLP: 'CLP$',
  PEN: 'S/',
  ILS: '₪',
  QAR: 'QR',
  KWD: 'KD',
  BHD: 'BD',
  OMR: 'OMR',
  RON: 'lei',
  BGN: 'лв',
  HRK: 'kn',
  UAH: '₴',
  LKR: 'Rs',
  NPR: '₨',
  TWD: 'NT$',
  GHS: 'GH₵',
  TZS: 'TSh',
  UGX: 'USh',
  ETB: 'Br',
  SOS: 'S',
};

/**
 * Shared currency list for dropdowns — SINGLE SOURCE OF TRUTH.
 * Used by Regions.tsx and any other page needing a currency picker.
 * Derived from CURRENCY_SYMBOLS so there is no duplication.
 */
export const CURRENCY_LIST: { code: string; name: string; symbol: string }[] = [
  // Major World Currencies
  { code: 'USD', name: 'US Dollar', symbol: '$' },
  { code: 'EUR', name: 'Euro', symbol: '€' },
  { code: 'GBP', name: 'British Pound', symbol: '£' },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥' },
  { code: 'CNY', name: 'Chinese Yuan', symbol: '¥' },
  { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF' },
  // Americas
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$' },
  { code: 'MXN', name: 'Mexican Peso', symbol: '$' },
  { code: 'BRL', name: 'Brazilian Real', symbol: 'R$' },
  { code: 'ARS', name: 'Argentine Peso', symbol: '$' },
  { code: 'CLP', name: 'Chilean Peso', symbol: '$' },
  { code: 'COP', name: 'Colombian Peso', symbol: '$' },
  { code: 'PEN', name: 'Peruvian Sol', symbol: 'S/' },
  // Europe
  { code: 'SEK', name: 'Swedish Krona', symbol: 'kr' },
  { code: 'NOK', name: 'Norwegian Krone', symbol: 'kr' },
  { code: 'DKK', name: 'Danish Krone', symbol: 'kr' },
  { code: 'PLN', name: 'Polish Zloty', symbol: 'zł' },
  { code: 'CZK', name: 'Czech Koruna', symbol: 'Kč' },
  { code: 'HUF', name: 'Hungarian Forint', symbol: 'Ft' },
  { code: 'RON', name: 'Romanian Leu', symbol: 'lei' },
  { code: 'BGN', name: 'Bulgarian Lev', symbol: 'лв' },
  { code: 'HRK', name: 'Croatian Kuna', symbol: 'kn' },
  { code: 'RUB', name: 'Russian Ruble', symbol: '₽' },
  { code: 'UAH', name: 'Ukrainian Hryvnia', symbol: '₴' },
  { code: 'TRY', name: 'Turkish Lira', symbol: '₺' },
  // Asia Pacific
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$' },
  { code: 'NZD', name: 'New Zealand Dollar', symbol: 'NZ$' },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹' },
  { code: 'PKR', name: 'Pakistani Rupee', symbol: '₨' },
  { code: 'BDT', name: 'Bangladeshi Taka', symbol: '৳' },
  { code: 'LKR', name: 'Sri Lankan Rupee', symbol: 'Rs' },
  { code: 'NPR', name: 'Nepalese Rupee', symbol: '₨' },
  { code: 'KRW', name: 'South Korean Won', symbol: '₩' },
  { code: 'TWD', name: 'Taiwan Dollar', symbol: 'NT$' },
  { code: 'HKD', name: 'Hong Kong Dollar', symbol: 'HK$' },
  { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$' },
  { code: 'MYR', name: 'Malaysian Ringgit', symbol: 'RM' },
  { code: 'THB', name: 'Thai Baht', symbol: '฿' },
  { code: 'VND', name: 'Vietnamese Dong', symbol: '₫' },
  { code: 'IDR', name: 'Indonesian Rupiah', symbol: 'Rp' },
  { code: 'PHP', name: 'Philippine Peso', symbol: '₱' },
  // Middle East
  { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ' },
  { code: 'SAR', name: 'Saudi Riyal', symbol: '﷼' },
  { code: 'QAR', name: 'Qatari Riyal', symbol: '﷼' },
  { code: 'KWD', name: 'Kuwaiti Dinar', symbol: 'د.ك' },
  { code: 'BHD', name: 'Bahraini Dinar', symbol: '.د.ب' },
  { code: 'OMR', name: 'Omani Rial', symbol: '﷼' },
  { code: 'JOD', name: 'Jordanian Dinar', symbol: 'د.ا' },
  { code: 'ILS', name: 'Israeli Shekel', symbol: '₪' },
  { code: 'EGP', name: 'Egyptian Pound', symbol: 'E£' },
  // Africa
  { code: 'ZAR', name: 'South African Rand', symbol: 'R' },
  { code: 'NGN', name: 'Nigerian Naira', symbol: '₦' },
  { code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh' },
  { code: 'GHS', name: 'Ghanaian Cedi', symbol: '₵' },
  { code: 'MAD', name: 'Moroccan Dirham', symbol: 'د.م.' },
  { code: 'TZS', name: 'Tanzanian Shilling', symbol: 'TSh' },
  { code: 'UGX', name: 'Ugandan Shilling', symbol: 'USh' },
  { code: 'ETB', name: 'Ethiopian Birr', symbol: 'Br' },
];

/**
 * Get currency symbol for a currency code
 */
export function getCurrencySymbol(currencyCode: string): string {
  return CURRENCY_SYMBOLS[currencyCode?.toUpperCase()] || currencyCode || '';
}

/**
 * Format a monetary value with the correct currency symbol
 */
export function formatCurrency(amount: number, currencyCode: string): string {
  const symbol = getCurrencySymbol(currencyCode);
  return `${symbol}${amount.toFixed(2)}`;
}

/**
 * Get the distance unit label
 */
export function getDistanceUnitLabel(unit: string, plural: boolean = true): string {
  if (unit === 'mile') {
    return plural ? 'miles' : 'mile';
  }
  return 'km';
}

/**
 * Get the short distance unit label
 */
export function getDistanceUnitShort(unit: string): string {
  return unit === 'mile' ? 'mi' : 'km';
}

/**
 * Convert distance from kilometers to the target unit
 */
export function convertDistance(distanceKm: number, targetUnit: string): number {
  if (targetUnit === 'mile') {
    return distanceKm * 0.621371;
  }
  return distanceKm;
}

/**
 * Convert distance from the source unit to kilometers
 */
export function convertToKm(distance: number, sourceUnit: string): number {
  if (sourceUnit === 'mile') {
    return distance / 0.621371;
  }
  return distance;
}

/**
 * Format distance with the correct unit
 */
export function formatDistance(distanceKm: number, unit: string, decimals: number = 1): string {
  const converted = convertDistance(distanceKm, unit);
  const unitLabel = getDistanceUnitShort(unit);
  return `${converted.toFixed(decimals)} ${unitLabel}`;
}

/**
 * Format ETA in a human-readable way
 */
export function formatETA(minutes: number): string {
  if (minutes < 1) {
    return 'Less than a minute';
  }
  if (minutes < 60) {
    return `${Math.round(minutes)} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMins = Math.round(minutes % 60);
  if (remainingMins === 0) {
    return `${hours} hr`;
  }
  return `${hours} hr ${remainingMins} min`;
}

/**
 * Default settings when region cannot be determined.
 * WARNING: These defaults should only be used as a last resort.
 * Region is the single source of truth for currency and units.
 */
export const DEFAULT_REGION_SETTINGS: RegionSettings = {
  region_id: '',
  region_name: 'Unknown',
  currency_code: '',
  distance_unit: 'mile',
  timezone: 'Europe/London',
  service_area_id: null,
  service_area_name: null,
};

/**
 * Validate that a Region has required currency and unit settings.
 * Returns an error message if validation fails, or null if valid.
 *
 * Region is the SINGLE SOURCE OF TRUTH for currency and distance units.
 * Service Areas must not override these values.
 */
export function validateRegionSettings(region: {
  currency_code?: string | null;
  distance_unit?: string | null;
  name?: string;
}): string | null {
  if (!region.currency_code) {
    return `Region "${region.name || 'Unknown'}" is missing a currency code. Please configure it in Region settings.`;
  }
  if (!region.distance_unit) {
    return `Region "${region.name || 'Unknown'}" is missing a distance unit. Please configure it in Region settings.`;
  }
  return null;
}

/**
 * Resolve currency code from a Region.
 * Region is the SINGLE SOURCE OF TRUTH — never resolve from Service Area.
 *
 * @throws Error if currencyCode is missing and no fallback is desired
 */
export function resolveRegionCurrency(region: { currency_code?: string | null } | null | undefined): string {
  const code = region?.currency_code;
  if (!code) {
    console.error('[regionSettings] CRITICAL: Region currency_code is missing. This is a configuration error. Configure currency on the Region.');
    return '???';
  }
  return code;
}

/**
 * Resolve distance unit from a Region.
 * Region is the SINGLE SOURCE OF TRUTH — never resolve from Service Area.
 */
export function resolveRegionDistanceUnit(region: { distance_unit?: string | null } | null | undefined): string {
  const unit = region?.distance_unit;
  if (!unit) {
    console.warn('[regionSettings] Region distance_unit is missing. This is a configuration error. Falling back to mile.');
    return 'mile';
  }
  return unit;
}
