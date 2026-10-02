/**
 * Persist canonical booking fare on trip insert — re-exports financial SSOT module.
 */
export {
  type BookingFarePersistInput,
  type BookingFinancialSnapshot,
  type DiscountSource,
  BookingFinancialSnapshotError,
  applyBookingFareToTripData,
  applyBookingFinancialSnapshotToTripData,
  buildBookingFinancialSnapshot,
  validateBookingFinancialSnapshot,
  computeBookingPricingHash,
} from "./tripDisplayFareSSOT.ts";
