/**
 * Payment workflow fare SSOT — edge functions.
 *
 * final_fare_pence =
 *   locked_base_fare_pence
 *   + arrival_waiting_charge_pence   (trips.pickup_waiting_charge_pence)
 *   + stop_waiting_charge_pence
 *   + customer_modification_charge_pence
 *   + airport_charge_pence
 *   + pass_through_charge_pence      (trips.other_pass_through_charges_pence)
 *   - discount_pence
 *
 * tips_pence = customer tip (100% driver, not commissionable)
 * capture completed = final_fare_pence + tips_pence
 * capture card no-show = no_show_charge_pence (partial capture releases hold)
 * cancelled before charge = 0 + cancel authorisation
 */

import {
  capTierCommissionPercent,
  computeDriverCommissionBreakdown,
  extractAirportChargePence,
  type DriverCommissionBreakdown,
} from "./commission-breakdown.ts";
import { resolveTripDisplayFare } from "./tripDisplayFareSSOT.ts";

export type TripFareRow = {
  final_fare_pence?: number | null;
  /** Customer payable ride fare locked at accept (promo net) — never subtract discount again. */
  final_customer_fare_pence?: number | null;
  fare_locked?: boolean | null;
  locked_base_fare_pence?: number | null;
  gross_fare_pence?: number | null;
  pickup_waiting_charge_pence?: number | null;
  stop_waiting_charge_pence?: number | null;
  stop_charge_total_pence?: number | null;
  total_waiting_charge_pence?: number | null;
  customer_modification_charge_pence?: number | null;
  destination_change_charge_pence?: number | null;
  stop_modification_charge_pence?: number | null;
  extras_pence?: number | null;
  airport_charge_pence?: number | null;
  other_pass_through_charges_pence?: number | null;
  offer_discount_pence?: number | null;
  promotion_discount_pence?: number | null;
  voucher_discount_pence?: number | null;
  discount_pence?: number | null;
  discount_source?: string | null;
  applied_personal_voucher_id?: string | null;
  tip_pence?: number | null;
  tip_amount_pence?: number | null;
  no_show_charge_pence?: number | null;
  fare?: number | null;
  estimated_fare?: number | null;
  estimated_total_pence?: number | null;
  fare_breakdown?: Record<string, unknown> | null;
  fare_snapshot_json?: Record<string, unknown> | null;
};

export type CaptureScenario = "completed" | "card_no_show" | "cancelled_before_charge";

export type ResolvedTripFare = {
  locked_base_fare_pence: number;
  arrival_waiting_charge_pence: number;
  stop_waiting_charge_pence: number;
  customer_modification_charge_pence: number;
  airport_charge_pence: number;
  pass_through_charge_pence: number;
  discount_pence: number;
  final_fare_pence: number;
  tips_pence: number;
};

export type CaptureResolution = {
  capture_amount_pence: number;
  cancel_authorisation: boolean;
};

function nonNegInt(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

/** Booking payable base — final_customer / display SSOT, never gross alone. */
export function resolveLockedBaseFarePence(trip: TripFareRow): number {
  const finalCustomer = nonNegInt(trip.final_customer_fare_pence);
  if (finalCustomer > 0) return finalCustomer;

  const finalPence = nonNegInt(trip.final_fare_pence);
  if (finalPence > 0) return finalPence;

  const display = resolveTripDisplayFare(trip);
  if (display.payable_pence > 0) return display.payable_pence;

  const explicit = nonNegInt(trip.locked_base_fare_pence);
  if (explicit > 0) return explicit;

  const estimated = nonNegInt(trip.estimated_total_pence);
  if (estimated > 0) return estimated;

  const fareMajor = Number(trip.fare ?? trip.estimated_fare ?? 0);
  if (Number.isFinite(fareMajor) && fareMajor > 0) {
    return Math.round(fareMajor * 100);
  }
  return 0;
}

/** pickup_waiting_charge_pence — persisted arrival waiting. */
export function resolveArrivalWaitingChargePence(trip: TripFareRow): number {
  return nonNegInt(trip.pickup_waiting_charge_pence);
}

/** stop_waiting_charge_pence with stop_charge_total_pence fallback. */
export function resolveStopWaitingChargePence(trip: TripFareRow): number {
  const stop = nonNegInt(trip.stop_waiting_charge_pence) || nonNegInt(trip.stop_charge_total_pence);
  if (stop > 0) return stop;

  // total_waiting may include pickup — subtract arrival to avoid double-count in SSOT sum
  const total = nonNegInt(trip.total_waiting_charge_pence);
  const arrival = resolveArrivalWaitingChargePence(trip);
  if (total > arrival) return total - arrival;
  return 0;
}

export type TripStopWaitingRow = {
  type?: string | null;
  waiting_total_amount_pence?: number | null;
  waiting_charge_pence?: number | null;
};

/** Sum intermediate stop waiting from trip_stops (canonical: waiting_total_amount_pence). */
export function sumIntermediateStopWaitingPence(
  tripStops?: TripStopWaitingRow[] | null,
): number {
  if (!tripStops?.length) return 0;
  return tripStops
    .filter((stop) => (stop.type ?? "").toLowerCase() === "stop")
    .reduce((sum, stop) => {
      const pence =
        nonNegInt(stop.waiting_total_amount_pence) || nonNegInt(stop.waiting_charge_pence);
      return sum + pence;
    }, 0);
}

/** Modification surcharges (destination change, stop edits, extras). */
export function resolveCustomerModificationChargePence(trip: TripFareRow): number {
  const direct = nonNegInt(trip.customer_modification_charge_pence);
  if (direct > 0) return direct;

  return (
    nonNegInt(trip.destination_change_charge_pence) +
    nonNegInt(trip.stop_modification_charge_pence) +
    nonNegInt(trip.extras_pence)
  );
}

export function resolveAirportChargePence(trip: TripFareRow): number {
  const direct = nonNegInt(trip.airport_charge_pence);
  if (direct > 0) return direct;
  return extractAirportChargePence(trip.fare_breakdown) ||
    extractAirportChargePence(trip.fare_snapshot_json);
}

export function resolvePassThroughChargePence(trip: TripFareRow): number {
  return nonNegInt(trip.other_pass_through_charges_pence);
}

export function resolveDiscountPence(trip: TripFareRow): number {
  const explicit = nonNegInt(trip.discount_pence);
  const source = resolveDiscountSource(trip);

  if (source === "personal_voucher") {
    return nonNegInt(trip.voucher_discount_pence) || explicit;
  }
  if (source === "global_offer") {
    return nonNegInt(trip.offer_discount_pence) ||
      nonNegInt(trip.promotion_discount_pence) ||
      explicit;
  }

  const voucher = nonNegInt(trip.voucher_discount_pence);
  if (voucher > 0) return voucher;
  const offer = nonNegInt(trip.offer_discount_pence) ||
    nonNegInt(trip.promotion_discount_pence);
  if (offer > 0) return offer;
  return explicit;
}

export type DiscountSource = "personal_voucher" | "global_offer" | null;

/** One discount source per trip — personal voucher wins over global/banner offer. */
export function resolveDiscountSource(trip: TripFareRow): DiscountSource {
  const src = trip.discount_source;
  if (src === "personal_voucher" || src === "global_offer") return src;
  if (nonNegInt(trip.voucher_discount_pence) > 0 || trip.applied_personal_voucher_id) {
    return "personal_voucher";
  }
  if (nonNegInt(trip.offer_discount_pence) > 0 || nonNegInt(trip.promotion_discount_pence) > 0) {
    return "global_offer";
  }
  return null;
}

export function resolveTipsPence(trip: TripFareRow, overridePence?: number): number {
  if (overridePence != null && overridePence >= 0) return Math.round(overridePence);
  return nonNegInt(trip.tip_pence) || nonNegInt(trip.tip_amount_pence);
}

/**
 * Ride fare base for settlement — excludes waiting/tolls/tips.
 * When fare_locked + final_customer_fare_pence, promo is already in that net (do not subtract discount again).
 */
export function resolveRideFareBasePence(trip: TripFareRow): number {
  const ssot = resolveTripDisplayFare(trip);
  if (ssot.payable_pence > 0) return ssot.payable_pence;

  const finalCustomer = nonNegInt(trip.final_customer_fare_pence);
  const lockedBase = nonNegInt(trip.locked_base_fare_pence);
  const discount = resolveDiscountPence(trip);
  const gross = nonNegInt(trip.gross_fare_pence);

  if (trip.fare_locked && finalCustomer > 0) {
    return finalCustomer;
  }

  if (lockedBase > 0) {
    if (finalCustomer > 0 && lockedBase === finalCustomer) {
      return lockedBase;
    }
    if (discount > 0 && gross > 0 && lockedBase + discount === gross) {
      return lockedBase;
    }
    if (discount > 0 && gross > 0 && lockedBase === gross) {
      return lockedBase;
    }
    return lockedBase;
  }

  return resolveLockedBaseFarePence(trip);
}

/** True when discount_pence is already reflected in the locked ride base / final_customer fare. */
export function isDiscountAlreadyInLockedRideBase(trip: TripFareRow): boolean {
  if (trip.fare_locked && nonNegInt(trip.final_customer_fare_pence) > 0) {
    return true;
  }
  const lockedBase = nonNegInt(trip.locked_base_fare_pence);
  const finalCustomer = nonNegInt(trip.final_customer_fare_pence);
  const discount = resolveDiscountPence(trip);
  const gross = nonNegInt(trip.gross_fare_pence);
  if (lockedBase > 0 && finalCustomer > 0 && lockedBase === finalCustomer && discount > 0) {
    return true;
  }
  if (lockedBase > 0 && discount > 0 && gross > 0 && lockedBase + discount === gross) {
    return true;
  }
  return false;
}

export function computeFinalFarePence(trip: TripFareRow): number {
  const rideBase = resolveRideFareBasePence(trip);
  const arrivalWaiting = resolveArrivalWaitingChargePence(trip);
  const stopWaiting = resolveStopWaitingChargePence(trip);
  const modification = resolveCustomerModificationChargePence(trip);
  const airport = resolveAirportChargePence(trip);
  const passThrough = resolvePassThroughChargePence(trip);
  const discount = resolveDiscountPence(trip);

  const subtotal =
    rideBase +
    arrivalWaiting +
    stopWaiting +
    modification +
    airport +
    passThrough;

  if (isDiscountAlreadyInLockedRideBase(trip)) {
    return Math.max(0, subtotal);
  }

  return Math.max(0, subtotal - Math.min(discount, subtotal));
}

export function resolveTripFare(
  trip: TripFareRow,
  tipsOverridePence?: number,
): ResolvedTripFare {
  const locked_base_fare_pence = resolveLockedBaseFarePence(trip);
  const arrival_waiting_charge_pence = resolveArrivalWaitingChargePence(trip);
  const stop_waiting_charge_pence = resolveStopWaitingChargePence(trip);
  const customer_modification_charge_pence = resolveCustomerModificationChargePence(trip);
  const airport_charge_pence = resolveAirportChargePence(trip);
  const pass_through_charge_pence = resolvePassThroughChargePence(trip);
  const discount_pence = resolveDiscountPence(trip);
  const final_fare_pence = computeFinalFarePence(trip);
  const tips_pence = resolveTipsPence(trip, tipsOverridePence);

  return {
    locked_base_fare_pence,
    arrival_waiting_charge_pence,
    stop_waiting_charge_pence,
    customer_modification_charge_pence,
    airport_charge_pence,
    pass_through_charge_pence,
    discount_pence,
    final_fare_pence,
    tips_pence,
  };
}

export function computeCaptureAmount(
  trip: TripFareRow,
  scenario: CaptureScenario,
  tipsOverridePence?: number,
): CaptureResolution {
  if (scenario === "cancelled_before_charge") {
    return { capture_amount_pence: 0, cancel_authorisation: true };
  }

  if (scenario === "card_no_show") {
    return {
      capture_amount_pence: nonNegInt(trip.no_show_charge_pence),
      cancel_authorisation: false,
    };
  }

  const fare = resolveTripFare(trip, tipsOverridePence);
  return {
    capture_amount_pence: fare.final_fare_pence + fare.tips_pence,
    cancel_authorisation: false,
  };
}

export function computeDriverEarningsBreakdown(
  trip: TripFareRow,
  commissionPercent: number,
  tipsOverridePence?: number,
): DriverCommissionBreakdown {
  const fare = resolveTripFare(trip, tipsOverridePence);
  const totalCustomer = fare.final_fare_pence + fare.tips_pence;

  return computeDriverCommissionBreakdown({
    totalCustomerFarePence: totalCustomer,
    airportChargePence: fare.airport_charge_pence,
    otherPassThroughChargesPence: fare.pass_through_charge_pence,
    tipsPence: fare.tips_pence,
    commissionPercent: capTierCommissionPercent(commissionPercent),
  });
}
