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
import {
  computeLiveTripFarePreview,
  type LiveTripFareInput,
} from './liveTripFareSSOT';

export type AdminCommittedFareTripRow = FareDisplayTripRow;

/** Map list/detail trip rows into live preview input (Active Trips enrich SSOT). */
export function toLiveTripFarePreviewInput(
  trip: AdminCommittedFareTripRow & {
    locked_base_fare_pence?: number | null;
    pickup_waiting_charge_pence?: number | null;
    stop_waiting_charge_pence?: number | null;
    stop_charge_total_pence?: number | null;
    customer_modification_charge_pence?: number | null;
    modification_delta_pence?: number | null;
    driver_tier_commission_percent?: number | null;
    commission_pct?: number | null;
    commission_pence?: number | null;
    accepted_commission_percent?: number | null;
  },
): LiveTripFareInput {
  return {
    final_customer_fare_pence: trip.final_customer_fare_pence ?? null,
    final_fare_pence: trip.final_fare_pence ?? null,
    locked_base_fare_pence: trip.locked_base_fare_pence ?? null,
    pickup_waiting_charge_pence: trip.pickup_waiting_charge_pence ?? null,
    stop_waiting_charge_pence: trip.stop_waiting_charge_pence ?? null,
    stop_charge_total_pence: trip.stop_charge_total_pence ?? null,
    customer_modification_charge_pence: trip.customer_modification_charge_pence ?? null,
    modification_delta_pence: trip.modification_delta_pence ?? null,
    driver_tier_commission_percent: trip.driver_tier_commission_percent ?? null,
    commission_pct: trip.commission_pct ?? null,
    commission_pence: trip.commission_pence ?? null,
    accepted_commission_percent: trip.accepted_commission_percent ?? null,
    gross_fare_pence: trip.gross_fare_pence ?? null,
    offer_discount_pence: trip.offer_discount_pence ?? null,
    discount_pence: trip.discount_pence ?? null,
  };
}

/**
 * Active Trips live customer total = committed fare + legitimate waiting (+ pre-fold mod only).
 * Falls back to committed resolver when preview is empty.
 */
export function resolveAdminActiveTripLiveFarePence(
  trip: Parameters<typeof toLiveTripFarePreviewInput>[0] | null | undefined,
): number {
  if (!trip) return 0;
  const live = computeLiveTripFarePreview(toLiveTripFarePreviewInput(trip));
  if (live.current_customer_total_pence > 0) return live.current_customer_total_pence;
  return resolveAdminCommittedCustomerFarePence(trip);
}

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
