/**
 * Admin tip / airport fare-component display helpers.
 * Display-only — formats stored SSOT stamps; never invents money or hardcodes rates.
 */

import { formatMoneyMinor } from '@/lib/formatMoneyMinor';

export const ADMIN_FARE_COMPONENT_UNKNOWN = 'Unknown';

/** True when a stored minor-unit value is present and strictly greater than zero. */
export function isPositiveStoredPence(pence: number | null | undefined): boolean {
  if (pence == null) return false;
  const n = Number(pence);
  return Number.isFinite(n) && n > 0;
}

/** Null / non-finite → null (legacy unavailable). Never coerce missing to 0. */
export function nullableStoredPence(pence: number | null | undefined): number | null {
  if (pence == null) return null;
  const n = Number(pence);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/**
 * Format stored pence for Admin finance rows.
 * Missing → "Unknown" (never £0.00 for null). Present zero → £0.00.
 */
export function formatStoredPenceOrUnknown(
  pence: number | null | undefined,
  currency = 'GBP',
): string {
  const n = nullableStoredPence(pence);
  if (n == null) return ADMIN_FARE_COMPONENT_UNKNOWN;
  return formatMoneyMinor(n, currency, 'en-GB', 2);
}

/** Compact signed chip amount for tip / airport (positive only). */
export function formatPositivePenceChipAmount(
  pence: number | null | undefined,
  currency = 'GBP',
): string | null {
  if (!isPositiveStoredPence(pence)) return null;
  return formatMoneyMinor(Number(pence), currency, 'en-GB', 2);
}

export function resolveTripTipPence(trip: {
  tip_pence?: number | null;
  tip_amount_pence?: number | null;
}): number | null {
  const direct = nullableStoredPence(trip.tip_pence);
  if (direct != null) return direct;
  return nullableStoredPence(trip.tip_amount_pence);
}

export function resolveTripAirportPence(trip: {
  airport_charge_pence?: number | null;
  airport_pence?: number | null;
}): number | null {
  const direct = nullableStoredPence(trip.airport_charge_pence);
  if (direct != null) return direct;
  return nullableStoredPence(trip.airport_pence);
}

export type FareComponentChip = {
  key: 'airport' | 'tip';
  label: string;
  ariaLabel: string;
};

/** Compact list chips when tip/airport known and > 0. Zero / null → omitted. */
export function buildTipAirportChips(args: {
  tipPence?: number | null;
  airportPence?: number | null;
  currency?: string;
}): FareComponentChip[] {
  const currency = args.currency ?? 'GBP';
  const chips: FareComponentChip[] = [];
  const airportAmt = formatPositivePenceChipAmount(args.airportPence, currency);
  if (airportAmt) {
    chips.push({
      key: 'airport',
      label: `Airport +${airportAmt}`,
      ariaLabel: `Airport charge ${airportAmt}`,
    });
  }
  const tipAmt = formatPositivePenceChipAmount(args.tipPence, currency);
  if (tipAmt) {
    chips.push({
      key: 'tip',
      label: `Tip +${tipAmt}`,
      ariaLabel: `Tip ${tipAmt}`,
    });
  }
  return chips;
}

/**
 * Sum known entitlement stamps for display only.
 * Any missing component → null (Unknown). Does not invent zeros for legacy nulls.
 */
export function sumKnownEntitlementComponentsPence(args: {
  fareNetPence: number | null | undefined;
  airportPence: number | null | undefined;
  tipPence: number | null | undefined;
}): number | null {
  const fare = nullableStoredPence(args.fareNetPence);
  const airport = nullableStoredPence(args.airportPence);
  const tip = nullableStoredPence(args.tipPence);
  if (fare == null || airport == null || tip == null) return null;
  return fare + airport + tip;
}

/** Difference of two stored totals; null if either side unknown. */
export function storedPenceDifference(
  actual: number | null | undefined,
  expected: number | null | undefined,
): number | null {
  const a = nullableStoredPence(actual);
  const e = nullableStoredPence(expected);
  if (a == null || e == null) return null;
  return a - e;
}

export function formatSignedStoredPenceOrUnknown(
  pence: number | null | undefined,
  currency = 'GBP',
): string {
  const n = nullableStoredPence(pence);
  if (n == null) return ADMIN_FARE_COMPONENT_UNKNOWN;
  const abs = formatMoneyMinor(Math.abs(n), currency, 'en-GB', 2);
  if (n > 0) return `+${abs}`;
  if (n < 0) return `−${abs}`;
  return abs;
}
