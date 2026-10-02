/**
 * Deno SSOT: customer-visible preauth / active-trip fare (mirrors src/lib/resolveDisplayFare.ts).
 */

import { resolveTripDisplayFare } from "./tripDisplayFareSSOT.ts";

export type TripFareRow = Record<string, unknown>;

export function nonNegInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function tripHasLockedCustomerFare(trip: TripFareRow): boolean {
  if (trip.fare_locked === true) return true;
  if (trip.fare_locked_at) return true;
  if (trip.accepted_ride_offer_id) return true;
  if (nonNegInt(trip.accepted_preset_offer_fare_pence) > 0) return true;
  if (nonNegInt(trip.accepted_driver_offer_fare_pence) > 0) return true;
  const snap = trip.fare_snapshot_json as Record<string, unknown> | null;
  if (snap?.accepted_at || snap?.accepted_fare_pence) return true;
  if (snap?.fare_source && snap.fare_source !== "original_fare") return true;
  return false;
}

/** Estimated total for preauth/display — uses resolveTripDisplayFare SSOT. */
export function resolveCustomerPreauthBasePence(trip: TripFareRow): number {
  if (tripHasLockedCustomerFare(trip)) {
    const preset = nonNegInt(trip.accepted_preset_offer_fare_pence);
    if (preset > 0) return preset;
    const driverOffer = nonNegInt(trip.accepted_driver_offer_fare_pence);
    if (driverOffer > 0) return driverOffer;
  }

  const payable = resolveTripDisplayFare(trip).payable_pence;
  if (payable > 0) return payable;

  return 1000;
}

/**
 * Mid-trip cash→card switch payable — SSOT preauth base plus accrued waiting.
 * Uses estimated_fare / estimated_total_pence (not the legacy £1 floor).
 */
export function resolveCashToCardSwitchPayablePence(trip: TripFareRow): number {
  const base = resolveCustomerPreauthBasePence(trip);
  const arrivalWaiting = Math.max(0, nonNegInt(trip.pickup_waiting_charge_pence));
  const stopWaiting = Math.max(
    0,
    nonNegInt(trip.total_waiting_charge_pence) || nonNegInt(trip.waiting_charge_pence),
  );
  return base + arrivalWaiting + stopWaiting;
}
