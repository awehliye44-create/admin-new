/**
 * Admin committed customer payable (ride fare) — shared across list surfaces.
 *
 * Priority:
 * 1. final_customer_fare_pence / final_fare_pence stamps (mod + promo already folded)
 * 2. resolvePayableFarePence canonical resolver
 * 3. estimated_fare / fare column pre-commit fallback only
 *
 * Never adds modification delta. Active Trips may stack live waiting separately.
 */

import {
  resolvePayableFarePence,
  resolveTripDisplayFare,
  type FareDisplayTripRow,
} from './fareDisplaySSOT';

export type AdminCommittedFareTripRow = FareDisplayTripRow;

function nonNeg(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

/** Committed customer ride payable in pence (excludes live waiting). */
export function resolveAdminCommittedCustomerFarePence(
  trip: AdminCommittedFareTripRow | null | undefined,
): number {
  if (!trip) return 0;

  const finalCustomer = nonNeg(trip.final_customer_fare_pence);
  if (finalCustomer > 0) return finalCustomer;

  const finalFare = nonNeg(trip.final_fare_pence);
  if (finalFare > 0) return finalFare;

  return resolvePayableFarePence(trip);
}

/** Committed fare in major units for table cells. */
export function resolveAdminCommittedCustomerFareMajor(
  trip: AdminCommittedFareTripRow | null | undefined,
): number {
  return resolveAdminCommittedCustomerFarePence(trip) / 100;
}

export function formatAdminCommittedCustomerFare(
  trip: AdminCommittedFareTripRow,
  currencySymbol: string,
): string {
  const pence = resolveAdminCommittedCustomerFarePence(trip);
  if (pence <= 0) return `${currencySymbol}0.00`;
  return `${currencySymbol}${(pence / 100).toFixed(2)}`;
}

/** Which stamp/resolver supplied the committed fare (for diagnostics). */
export function resolveAdminCommittedCustomerFareSource(
  trip: AdminCommittedFareTripRow | null | undefined,
): string {
  if (!trip) return 'none';
  if (nonNeg(trip.final_customer_fare_pence) > 0) return 'final_customer_fare_pence';
  if (nonNeg(trip.final_fare_pence) > 0) return 'final_fare_pence';
  return resolveTripDisplayFare(trip).source;
}
