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

// Currency symbol mapping
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
};

/**
 * Get currency symbol for a currency code
 */
export function getCurrencySymbol(currencyCode: string): string {
  return CURRENCY_SYMBOLS[currencyCode?.toUpperCase()] || currencyCode || '$';
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
