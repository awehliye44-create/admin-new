/**
 * Pure arithmetic mirror of `apply_trip_modification_to_trip` fare fold.
 *
 * DB SSOT: public.apply_trip_modification_to_trip
 * Edge preview SSOT: computeModificationFareDelta → p_new_fare_pence (already net).
 *
 * Rules locked by MK-260816-003:
 * - cumulative modification adjustment is SIGNED (never GREATEST(0, …))
 * - final payable floors at 1p (not by zeroing the accumulator)
 * - existing offer/promotion discount is applied exactly once
 * - waiting is NOT part of this fold
 */

export type FoldTripModificationFareInput = {
  /** Existing locked / quoted gross base before cumulative mods. */
  lockedBasePence: number;
  /** Existing offer/voucher discount already reflected in committed net. */
  discountPence: number;
  /** Prior signed cumulative modification adjustment. */
  priorModificationChargePence: number;
  /** This revision's signed remaining-route delta. */
  fareDeltaPence: number;
  /**
   * Edge-authoritative new customer payable (already net of the existing
   * discount). Prefer this over reconstructing when present and > 0.
   */
  newFarePence: number;
};

export type FoldTripModificationFareResult = {
  /** Signed cumulative adjustment after this revision. */
  customerModificationChargePence: number;
  /** Committed customer payable (net). */
  finalCustomerFarePence: number;
  /** Gross = net + existing discount (promotion stays applied once). */
  grossFarePence: number;
  /** Same as final — capture / final_fare columns. */
  captureAmountPence: number;
  /** Per-revision signed destination adjustment (may be negative). */
  destinationChangeAdjustmentPence: number;
};

const FINAL_FARE_FLOOR_PENCE = 1;

export function foldTripModificationFare(
  input: FoldTripModificationFareInput,
): FoldTripModificationFareResult {
  const prior = Math.round(input.priorModificationChargePence);
  const delta = Math.round(input.fareDeltaPence);
  const discount = Math.max(0, Math.round(input.discountPence));
  const customerModificationChargePence = prior + delta;

  // Edge newFare is already net; do not subtract the promotion again.
  const fromEdge = Math.round(input.newFarePence);
  const reconstructed =
    Math.round(input.lockedBasePence) + customerModificationChargePence - discount;
  const finalCustomerFarePence = Math.max(
    FINAL_FARE_FLOOR_PENCE,
    fromEdge > 0 ? fromEdge : reconstructed,
  );
  const grossFarePence = finalCustomerFarePence + discount;

  return {
    customerModificationChargePence,
    finalCustomerFarePence,
    grossFarePence,
    captureAmountPence: finalCustomerFarePence,
    destinationChangeAdjustmentPence: delta,
  };
}
