/**
 * SSOT for preset chip math â delegates to resolveTripDisplayFare for booking payable.
 */

import { resolveTripDisplayFare } from "./tripDisplayFareSSOT.ts";

export type TripForNegotiationBase = {
  base_fare_pence?: number | null;
  estimated_fare?: number | null;
  fare?: number | null;
  fare_breakdown?: unknown;
  gross_fare_pence?: number | null;
  offer_discount_pence?: number | null;
  promotion_discount_pence?: number | null;
  discount_pence?: number | null;
  final_customer_fare_pence?: number | null;
  final_fare_pence?: number | null;
  estimated_total_pence?: number | null;
  fare_snapshot_json?: Record<string, unknown> | null;
};

function moneyToPence(raw: unknown): number | null {
  if (raw == null || !Number.isFinite(Number(raw))) return null;
  const n = Number(raw);
  if (n <= 0) return null;
  return Math.round(n * 100);
}

function fareToPence(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

function isRoutePricingBreakdown(fb: Record<string, unknown>): boolean {
  return (
    fb.pricing_mode === "ROUTE_PRICING" ||
    fb.pricingMode === "ROUTE_PRICING" ||
    fb.tripPricingMode === "ROUTE_PRICING" ||
    fb.fixedFareApplied === true
  );
}

/** @deprecated Prefer parseVisibleFarePenceFromBreakdown â kept for callers/tests. */
export function parseFareBreakdownTripFarePence(fareBreakdown: unknown): number | null {
  if (!fareBreakdown || typeof fareBreakdown !== "object") return null;
  const fb = fareBreakdown as Record<string, unknown>;
  const tripFare = fb.tripFare ?? fb.trip_fare;
  return moneyToPence(tripFare);
}

/** Visible card fare from fare_breakdown (final/total, or trip + airport for route). */
export function parseVisibleFarePenceFromBreakdown(fareBreakdown: unknown): number | null {
  if (!fareBreakdown || typeof fareBreakdown !== "object") return null;
  const fb = fareBreakdown as Record<string, unknown>;

  for (const key of ["finalFare", "final_fare", "totalFare", "total_fare"] as const) {
    const pence = moneyToPence(fb[key]);
    if (pence != null) return pence;
  }

  const tripPence = moneyToPence(fb.tripFare ?? fb.trip_fare);
  if (tripPence == null) return null;

  if (isRoutePricingBreakdown(fb)) {
    const airportPence = moneyToPence(fb.airportCharge ?? fb.airport_charge) ?? 0;
    return tripPence + airportPence;
  }

  return tripPence;
}

export function resolvePromotionDiscountPence(trip: TripForNegotiationBase): number {
  const fromColumn =
    (trip.discount_pence != null && trip.discount_pence > 0
      ? Math.round(trip.discount_pence)
      : null)
    ?? (trip.offer_discount_pence != null && trip.offer_discount_pence > 0
      ? Math.round(trip.offer_discount_pence)
      : null)
    ?? (trip.promotion_discount_pence != null && trip.promotion_discount_pence > 0
      ? Math.round(trip.promotion_discount_pence)
      : null);

  if (fromColumn != null) return fromColumn;

  const snap = trip.fare_snapshot_json;
  if (!snap || typeof snap !== "object") return 0;

  for (const key of [
    "discount_pence",
    "promotion_discount_pence",
    "offer_discount_pence",
  ] as const) {
    const n = Number(snap[key]);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return 0;
}

export function resolveOriginalGrossFarePence(trip: TripForNegotiationBase): number {
  if (trip.gross_fare_pence != null && trip.gross_fare_pence > 0) {
    return Math.round(trip.gross_fare_pence);
  }
  const snap = trip.fare_snapshot_json;
  if (snap && typeof snap === "object") {
    const g = Number(snap.gross_fare_pence);
    if (Number.isFinite(g) && g > 0) return Math.round(g);
  }
  return 0;
}

function snapshotPayablePence(trip: TripForNegotiationBase): number | null {
  const snap = trip.fare_snapshot_json;
  if (!snap || typeof snap !== "object") return null;
  for (const key of [
    "base_payable_fare_pence",
    "canonical_payable_fare_pence",
    "final_payable_fare_pence",
    "fare_after_discount_pence",
  ] as const) {
    const n = Number(snap[key]);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return null;
}

/** Raw visible ride fare before promotion discount (card total / estimated). */
export function resolveVisibleRideFarePence(trip: TripForNegotiationBase): number {
  const estimatedPence =
    fareToPence(trip.estimated_fare ?? trip.fare)
    || (trip.estimated_total_pence != null && trip.estimated_total_pence > 0
      ? Math.round(trip.estimated_total_pence)
      : 0);
  const fromBreakdown = parseVisibleFarePenceFromBreakdown(trip.fare_breakdown);

  if (fromBreakdown != null && fromBreakdown > 0 && estimatedPence > 0) {
    if (estimatedPence > fromBreakdown * 1.05) return estimatedPence;
    return fromBreakdown;
  }

  if (fromBreakdown != null && fromBreakdown > 0) return fromBreakdown;

  const stored = trip.base_fare_pence;
  if (estimatedPence > 0) {
    if (stored != null && stored > 0 && stored >= Math.round(estimatedPence * 0.85)) {
      return stored;
    }
    return estimatedPence;
  }

  return stored != null && stored > 0 ? stored : 0;
}

/**
 * base_payable_fare_pence = booking payable from financial SSOT.
 */
export function resolveBasePayableFarePence(trip: TripForNegotiationBase): number {
  const ssot = resolveTripDisplayFare(trip);
  if (ssot.payable_pence > 0) return ssot.payable_pence;

  const fromSnapshot = snapshotPayablePence(trip);
  if (fromSnapshot != null) return fromSnapshot;

  const bookingNet =
    trip.final_customer_fare_pence != null && trip.final_customer_fare_pence > 0
      ? Math.round(trip.final_customer_fare_pence)
      : null;
  const gross = resolveOriginalGrossFarePence(trip);
  const discount = resolvePromotionDiscountPence(trip);

  if (bookingNet != null && (gross <= 0 || bookingNet < gross)) {
    return bookingNet;
  }

  const visible = resolveVisibleRideFarePence(trip);
  const farePence = fareToPence(trip.fare ?? trip.estimated_fare);

  if (farePence > 0 && gross > 0 && discount > 0 && farePence + discount === gross) {
    return farePence;
  }

  if (discount > 0 && gross > 0 && visible >= gross) {
    return Math.max(0, gross - discount);
  }

  if (discount > 0 && visible > 0 && gross > 0 && visible === gross) {
    return Math.max(0, gross - discount);
  }

  return visible > 0 ? visible : Math.max(0, gross - discount);
}

/**
 * Resolve negotiation base fare for preset chip math (base_payable_fare_pence).
 */
export function resolveNegotiationBaseFarePence(trip: TripForNegotiationBase): number {
  return resolveBasePayableFarePence(trip);
}
