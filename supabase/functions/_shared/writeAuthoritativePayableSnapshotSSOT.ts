/**
 * Authoritative payable snapshot writers — shared backend entry for all channels.
 * Unaccepted proposals must NOT call this. COUNTER must NOT call this.
 * Agreed fare / applied modification / completion / force_complete / recovery do.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  buildPayableFareSnapshot,
  forceCompletePayableSnapshot,
  type PayableFareSnapshot,
  type PayableSnapshotSource,
  type WaitingBasis,
} from "./payableFareSnapshotSSOT.ts";
import { persistPayableFareSnapshot } from "./paymentFinancialOperationPersistSSOT.ts";
import {
  isAirportAlreadyInRideBase,
  isDiscountAlreadyInLockedRideBase,
  isModificationAlreadyInRideBase,
  resolveArrivalWaitingChargePence,
  resolveAirportChargePence,
  resolveCustomerModificationChargePence,
  resolveDiscountPence,
  resolvePassThroughChargePence,
  resolveRideFareBasePence,
  resolveStopWaitingChargePence,
  resolveTipsPence,
  type TripFareRow,
} from "./tripFareSSOT.ts";

export type TripPayableSnapshotRow = TripFareRow & {
  id?: string;
  locked_base_fare_pence?: number | null;
  final_customer_fare_pence?: number | null;
  final_fare_pence?: number | null;
  gross_fare_pence?: number | null;
  customer_modification_charge_pence?: number | null;
  modification_delta_pence?: number | null;
  pickup_waiting_charge_pence?: number | null;
  stop_waiting_charge_pence?: number | null;
  total_waiting_charge_pence?: number | null;
  offer_discount_pence?: number | null;
  voucher_discount_pence?: number | null;
  airport_charge_pence?: number | null;
  other_pass_through_charges_pence?: number | null;
  tip_pence?: number | null;
  tip_amount_pence?: number | null;
  currency_code?: string | null;
};

function nonNeg(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Build snapshot from committed trip columns (not live projections).
 * Waiting counted once via waitingBasis.
 */
export function buildAuthoritativePayableFromTrip(args: {
  trip: TripPayableSnapshotRow;
  source: PayableSnapshotSource;
  tipPence?: number | null;
  receivablesPence?: number | null;
  waitingBasis?: WaitingBasis;
  /** When set, overrides computed total (e.g. force_complete admin fare). */
  totalPayableOverridePence?: number | null;
}): PayableFareSnapshot {
  const trip = {
    ...args.trip,
    customer_modification_charge_pence:
      args.trip.customer_modification_charge_pence ?? args.trip.modification_delta_pence,
  };
  const waitingBasis = args.waitingBasis ?? "columns";
  const waitingColumns =
    resolveArrivalWaitingChargePence(trip) + resolveStopWaitingChargePence(trip);
  // Use the same effective additions as capture: folded charges/discounts are
  // audit columns, not extra payable. Never rebuild a second fare formula.
  const rideBase = resolveRideFareBasePence(trip);
  const modification = isModificationAlreadyInRideBase(trip, rideBase)
    ? 0 : resolveCustomerModificationChargePence(trip);
  const airport = isAirportAlreadyInRideBase(trip, rideBase)
    ? 0 : resolveAirportChargePence(trip);
  const discountIncluded = isDiscountAlreadyInLockedRideBase(trip)
    || (nonNeg(trip.final_customer_fare_pence) > 0
      && rideBase === nonNeg(trip.final_customer_fare_pence));
  const discount = discountIncluded ? 0 : resolveDiscountPence(trip);
  const tip = resolveTipsPence(trip, args.tipPence ?? undefined);

  if (args.totalPayableOverridePence != null) {
    return forceCompletePayableSnapshot({
      adminFarePence: nonNeg(args.totalPayableOverridePence),
      pickupWaitingPence: trip.pickup_waiting_charge_pence,
      stopWaitingPence: trip.stop_waiting_charge_pence,
      airportPence: trip.airport_charge_pence,
      tipPence: tip,
      receivablesPence: args.receivablesPence,
      adminFareIncludesWaiting: waitingBasis === "included_in_fare",
    });
  }

  return buildPayableFareSnapshot({
    source: args.source,
    grossFarePence: rideBase,
    modificationPence: modification,
    waitingPence: waitingColumns,
    waitingBasis,
    discountPence: discount,
    airportPassThroughPence:
      airport + resolvePassThroughChargePence(trip),
    tipPence: tip,
    receivablesPence: args.receivablesPence,
    currency: String(trip.currency_code ?? "GBP"),
  });
}

export async function writeAuthoritativePayableSnapshot(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    trip: TripPayableSnapshotRow;
    source: PayableSnapshotSource;
    tipPence?: number | null;
    receivablesPence?: number | null;
    waitingBasis?: WaitingBasis;
    totalPayableOverridePence?: number | null;
  },
): Promise<{ ok: true; id: string; version: number; snapshot: PayableFareSnapshot } | {
  ok: false;
  error: string;
}> {
  const snapshot = buildAuthoritativePayableFromTrip(args);
  const persisted = await persistPayableFareSnapshot(supabase, {
    tripId: args.tripId,
    snapshot,
  });
  if ("error" in persisted) {
    // Missing table during Stage A soft: surface error for callers to log; do not invent evidence.
    return { ok: false, error: persisted.error };
  }
  return {
    ok: true,
    id: persisted.id,
    version: persisted.version,
    snapshot,
  };
}

/** Sources that may write authoritative payable (agreed / applied only). */
export const AUTHORITATIVE_PAYABLE_SOURCES: readonly PayableSnapshotSource[] = [
  "booking",
  "completion",
  "modification",
  "negotiation_commit",
  "force_complete",
  "tip_finalize",
  "admin_capture",
  "composition",
  "recovery",
] as const;
