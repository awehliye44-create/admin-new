/**
 * Client financial display SSOT — mirrors supabase/functions/_shared/tripDisplayFareSSOT.ts
 */

export type FareDisplayTripRow = {
  final_fare_pence?: number | null;
  final_customer_fare_pence?: number | null;
  capture_amount_pence?: number | null;
  estimated_total_pence?: number | null;
  gross_fare_pence?: number | null;
  offer_discount_pence?: number | null;
  voucher_discount_pence?: number | null;
  promotion_discount_pence?: number | null;
  discount_pence?: number | null;
  discount_source?: string | null;
  fare?: number | null;
  estimated_fare?: number | null;
  fare_snapshot_json?: Record<string, unknown> | null;
};

export type TripDisplayFareSource =
  | "final_customer_fare_pence"
  | "final_fare_pence"
  | "estimated_total_pence"
  | "gross_minus_discount"
  | "gross_fare_pence"
  | "fare_column"
  | "none";

export type ResolvedTripDisplayFare = {
  payable_pence: number;
  payable_major: number;
  original_pence: number | null;
  original_major: number | null;
  discount_pence: number;
  commission_base_pence: number;
  source: TripDisplayFareSource;
};

const nonNeg = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
};

export function resolveDiscountPenceFromTrip(trip: FareDisplayTripRow | null | undefined): number {
  if (!trip) return 0;
  const explicit = nonNeg(trip.discount_pence);
  if (explicit > 0) return explicit;
  const source = trip.discount_source;
  if (source === "personal_voucher") return nonNeg(trip.voucher_discount_pence);
  if (source === "global_offer") {
    return nonNeg(trip.offer_discount_pence) || nonNeg(trip.promotion_discount_pence);
  }
  return Math.max(
    nonNeg(trip.offer_discount_pence),
    nonNeg(trip.voucher_discount_pence),
    nonNeg(trip.promotion_discount_pence),
  );
}

export function resolveOriginalFarePence(trip: FareDisplayTripRow): number | null {
  const gross = nonNeg(trip.gross_fare_pence);
  if (gross > 0) return gross;
  const snap = trip.fare_snapshot_json;
  if (snap && typeof snap === "object") {
    const fromSnap = nonNeg(snap.gross_fare_pence);
    if (fromSnap > 0) return fromSnap;
  }
  return null;
}

const EMPTY_RESOLVED_FARE: ResolvedTripDisplayFare = {
  payable_pence: 0,
  payable_major: 0,
  original_pence: null,
  original_major: null,
  discount_pence: 0,
  commission_base_pence: 0,
  source: 'none',
};

export function resolveTripDisplayFare(trip: FareDisplayTripRow | null | undefined): ResolvedTripDisplayFare {
  if (!trip) return EMPTY_RESOLVED_FARE;
  const discount = resolveDiscountPenceFromTrip(trip);
  const original = resolveOriginalFarePence(trip);
  const snap = trip.fare_snapshot_json;

  const snapPayable =
    nonNeg(snap?.final_customer_fare_pence) ||
    nonNeg(snap?.canonical_payable_fare_pence) ||
    nonNeg(snap?.final_payable_fare_pence) ||
    nonNeg(snap?.fare_after_discount_pence);

  let payable = 0;
  let source: TripDisplayFareSource = "none";

  const finalCustomer = nonNeg(trip.final_customer_fare_pence);
  if (finalCustomer > 0) {
    payable = finalCustomer;
    source = "final_customer_fare_pence";
  } else if (snapPayable > 0) {
    payable = snapPayable;
    source = "final_customer_fare_pence";
  } else {
    const finalFare = nonNeg(trip.final_fare_pence);
    if (finalFare > 0) {
      payable = finalFare;
      source = "final_fare_pence";
      if (discount > 0 && original != null && finalFare === original) {
        payable = Math.max(0, finalFare - discount);
        source = "gross_minus_discount";
      }
    } else {
      const estimatedTotal = nonNeg(trip.estimated_total_pence);
      if (estimatedTotal > 0) {
        payable = estimatedTotal;
        source = "estimated_total_pence";
      } else if (original != null && discount > 0) {
        payable = Math.max(0, original - discount);
        source = "gross_minus_discount";
      } else if (original != null) {
        payable = original;
        source = "gross_fare_pence";
      } else {
        const fareMajor = Number(trip.fare ?? trip.estimated_fare ?? 0);
        if (Number.isFinite(fareMajor) && fareMajor > 0) {
          payable = Math.round(fareMajor * 100);
          source = "fare_column";
        }
      }
    }
  }

  payable = Math.max(0, Math.round(payable));

  return {
    payable_pence: payable,
    payable_major: payable / 100,
    original_pence: original,
    original_major: original != null ? original / 100 : null,
    discount_pence: discount,
    commission_base_pence: payable,
    source,
  };
}

export function resolvePayableFarePence(trip: FareDisplayTripRow | null | undefined): number {
  return resolveTripDisplayFare(trip).payable_pence;
}

export function fareDisplaySSOT(trip: FareDisplayTripRow | null | undefined) {
  const resolved = resolveTripDisplayFare(trip);
  return {
    payable_fare_pence: resolved.payable_pence,
    original_fare_pence: resolved.original_pence,
    discount_pence: resolved.discount_pence,
  };
}
