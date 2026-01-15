/**
 * Timezone-aware utilities for global operations
 * All date calculations use service area timezones via IANA identifiers
 */

/**
 * Get start of day in a specific timezone
 * Returns UTC timestamp for database queries
 */
export function getStartOfDayInTimezone(date: Date, timezone: string): Date {
  // Format date in target timezone to get the local date parts
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  
  const parts = formatter.formatToParts(date);
  const year = parseInt(parts.find(p => p.type === 'year')?.value || '0');
  const month = parseInt(parts.find(p => p.type === 'month')?.value || '0') - 1;
  const day = parseInt(parts.find(p => p.type === 'day')?.value || '0');
  
  // Create a date string for midnight in that timezone
  const midnightLocal = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  
  // Get the offset at midnight in that timezone
  const offsetMs = getTimezoneOffsetMs(midnightLocal, timezone);
  
  // Return UTC time that corresponds to midnight in the target timezone
  return new Date(midnightLocal.getTime() - offsetMs);
}

/**
 * Get end of day in a specific timezone
 * Returns UTC timestamp for database queries
 */
export function getEndOfDayInTimezone(date: Date, timezone: string): Date {
  const startOfDay = getStartOfDayInTimezone(date, timezone);
  return new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);
}

/**
 * Get start of week (Monday) in a specific timezone
 */
export function getStartOfWeekInTimezone(date: Date, timezone: string): Date {
  const startOfDay = getStartOfDayInTimezone(date, timezone);
  
  // Get day of week in that timezone (0 = Sunday)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  });
  const weekday = formatter.format(date);
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const currentDay = dayMap[weekday] || 0;
  
  // Calculate days to subtract to get to Monday (1)
  const daysToMonday = currentDay === 0 ? 6 : currentDay - 1;
  
  return new Date(startOfDay.getTime() - daysToMonday * 24 * 60 * 60 * 1000);
}

/**
 * Get start of month in a specific timezone
 */
export function getStartOfMonthInTimezone(date: Date, timezone: string): Date {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  });
  
  const parts = formatter.formatToParts(date);
  const year = parseInt(parts.find(p => p.type === 'year')?.value || '0');
  const month = parseInt(parts.find(p => p.type === 'month')?.value || '0') - 1;
  
  const firstOfMonth = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const offsetMs = getTimezoneOffsetMs(firstOfMonth, timezone);
  
  return new Date(firstOfMonth.getTime() - offsetMs);
}

/**
 * Get timezone offset in milliseconds for a specific date
 * Handles DST correctly
 */
function getTimezoneOffsetMs(date: Date, timezone: string): number {
  // Get the date string in the target timezone
  const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
  const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  
  return tzDate.getTime() - utcDate.getTime();
}

/**
 * Format a UTC date for display in a specific timezone
 */
export function formatInTimezone(date: Date | string, timezone: string, options?: Intl.DateTimeFormatOptions): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  
  return d.toLocaleString('en-US', {
    timeZone: timezone,
    ...options,
  });
}

/**
 * Format time only in timezone
 */
export function formatTimeInTimezone(date: Date | string, timezone: string): string {
  return formatInTimezone(date, timezone, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Format date only in timezone
 */
export function formatDateInTimezone(date: Date | string, timezone: string): string {
  return formatInTimezone(date, timezone, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Get "today" label with timezone awareness
 */
export function getTodayLabel(timezone: string): string {
  const now = new Date();
  return formatDateInTimezone(now, timezone);
}

/**
 * Check if a UTC timestamp falls within "today" in a specific timezone
 */
export function isToday(utcDate: Date | string, timezone: string): boolean {
  const d = typeof utcDate === 'string' ? new Date(utcDate) : utcDate;
  const now = new Date();
  
  const startOfToday = getStartOfDayInTimezone(now, timezone);
  const endOfToday = getEndOfDayInTimezone(now, timezone);
  
  return d >= startOfToday && d <= endOfToday;
}

/**
 * Common timezone presets for quick selection
 */
export const COMMON_TIMEZONES = [
  { value: 'Europe/London', label: 'London (GMT/BST)', region: 'Europe' },
  { value: 'Europe/Paris', label: 'Paris (CET/CEST)', region: 'Europe' },
  { value: 'Europe/Berlin', label: 'Berlin (CET/CEST)', region: 'Europe' },
  { value: 'America/New_York', label: 'New York (EST/EDT)', region: 'Americas' },
  { value: 'America/Chicago', label: 'Chicago (CST/CDT)', region: 'Americas' },
  { value: 'America/Los_Angeles', label: 'Los Angeles (PST/PDT)', region: 'Americas' },
  { value: 'Africa/Lagos', label: 'Lagos (WAT)', region: 'Africa' },
  { value: 'Africa/Nairobi', label: 'Nairobi (EAT)', region: 'Africa' },
  { value: 'Africa/Johannesburg', label: 'Johannesburg (SAST)', region: 'Africa' },
  { value: 'Asia/Dubai', label: 'Dubai (GST)', region: 'Asia' },
  { value: 'Asia/Singapore', label: 'Singapore (SGT)', region: 'Asia' },
  { value: 'Asia/Tokyo', label: 'Tokyo (JST)', region: 'Asia' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST/AEDT)', region: 'Oceania' },
  { value: 'Australia/Perth', label: 'Perth (AWST)', region: 'Oceania' },
  { value: 'Pacific/Auckland', label: 'Auckland (NZST/NZDT)', region: 'Oceania' },
] as const;

/**
 * Common currency presets
 */
export const COMMON_CURRENCIES = [
  { code: 'GBP', symbol: '£', name: 'British Pound', locale: 'en-GB' },
  { code: 'EUR', symbol: '€', name: 'Euro', locale: 'de-DE' },
  { code: 'USD', symbol: '$', name: 'US Dollar', locale: 'en-US' },
  { code: 'NGN', symbol: '₦', name: 'Nigerian Naira', locale: 'en-NG' },
  { code: 'KES', symbol: 'KSh', name: 'Kenyan Shilling', locale: 'en-KE' },
  { code: 'ZAR', symbol: 'R', name: 'South African Rand', locale: 'en-ZA' },
  { code: 'AED', symbol: 'د.إ', name: 'UAE Dirham', locale: 'ar-AE' },
  { code: 'AUD', symbol: 'A$', name: 'Australian Dollar', locale: 'en-AU' },
  { code: 'NZD', symbol: 'NZ$', name: 'New Zealand Dollar', locale: 'en-NZ' },
  { code: 'SGD', symbol: 'S$', name: 'Singapore Dollar', locale: 'en-SG' },
  { code: 'JPY', symbol: '¥', name: 'Japanese Yen', locale: 'ja-JP' },
  { code: 'INR', symbol: '₹', name: 'Indian Rupee', locale: 'en-IN' },
] as const;

/**
 * Format currency amount
 */
export function formatCurrency(amount: number, currencyCode: string): string {
  const currency = COMMON_CURRENCIES.find(c => c.code === currencyCode);
  const locale = currency?.locale || 'en-US';
  
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: currencyCode === 'JPY' ? 0 : 2,
    maximumFractionDigits: currencyCode === 'JPY' ? 0 : 2,
  }).format(amount);
}

/**
 * Format currency from minor units (cents/pence)
 */
export function formatCurrencyFromMinor(minorUnits: number, currencyCode: string): string {
  const majorUnits = currencyCode === 'JPY' ? minorUnits : minorUnits / 100;
  return formatCurrency(majorUnits, currencyCode);
}
