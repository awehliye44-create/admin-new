/**
 * Tip-window channel eligibility SSOT.
 * Only Customer App card trips may enter the deferred tip window / submit tips.
 */
import {
  isCorporateTripIneligibleForPresetNegotiation,
  isWhatsAppTripIneligibleForPresetNegotiation,
  normalizeTripBookingSource,
} from "./presetNegotiationEligibility.ts";

export type TipChannelTripLike = {
  booking_source?: string | null;
  corporate_account_id?: string | null;
};

/** Positive allowlist for Customer App booking_source values. */
export function isCustomerAppTipBookingSource(raw: unknown): boolean {
  const source = normalizeTripBookingSource(raw);
  return (
    source === "customer" ||
    source === "customer_app" ||
    source === "choose_ride"
  );
}

/**
 * True only for Customer App channel trips.
 * Excludes WhatsApp / guest web / corporate portal / corporate account.
 */
export function isCustomerAppTipChannelEligible(trip: TipChannelTripLike): boolean {
  if (isCorporateTripIneligibleForPresetNegotiation(trip)) return false;
  if (isWhatsAppTripIneligibleForPresetNegotiation(trip)) return false;
  return isCustomerAppTipBookingSource(trip.booking_source);
}
