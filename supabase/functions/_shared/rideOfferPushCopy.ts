/**
 * Mirrors `public.ride_offer_build_send_notification_body` alert line + helpers
 * for Edge Functions that send ride-offer pushes outside the INSERT trigger path.
 */ import { getCurrencySymbol } from "./currency.ts";
import { resolveTripDisplayFare } from "./tripDisplayFareSSOT.ts";
import { DRIVER_NEW_RIDE_OFFER_IOS_SOUND } from "./alertSoundOsPush.ts";
/**
 * iOS APNs `aps.sound` — must match bundled `onecab_new_ride_offer.wav`
 * (Driver native registry). CAF is not bundled and must not be emitted.
 */ export const RIDE_OFFER_IOS_ALERT_SOUND = DRIVER_NEW_RIDE_OFFER_IOS_SOUND;
function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  }
  return null;
}
/** Pickup line for notification body (`Tap to view details` if empty); max 160 chars. */ export function pickupSummaryForRideOfferPush(pickupAddress) {
  const t = (pickupAddress ?? "").trim();
  if (!t) return "Tap to view details";
  return t.length <= 160 ? t : t.slice(0, 160);
}
/**
 * Passenger fare amount in major units — uses resolveTripDisplayFare SSOT.
 */ export function majorFareUnitFromTrip(trip) {
  const resolved = resolveTripDisplayFare(trip);
  if (resolved.payable_pence > 0) return resolved.payable_major;
  const fare = num(trip.fare);
  const estimatedFare = num(trip.estimated_fare);
  const finalPence = num(trip.final_fare_pence);
  const grossPence = num(trip.gross_fare_pence);
  const estimatedTotalPence = num(trip.estimated_total_pence);
  let major = (finalPence != null ? finalPence / 100 : null) ?? fare ?? estimatedFare ?? (grossPence != null ? grossPence / 100 : null) ?? (estimatedTotalPence != null ? estimatedTotalPence / 100 : null);
  if (major == null || !Number.isFinite(major)) return null;
  if (major >= 500 && fare == null && estimatedFare == null) {
    major = major / 100;
  }
  return major;
}
export function fareDisplayForRideOfferPush(currencyCode, major) {
  const ccy = String(currencyCode ?? "").trim().toUpperCase();
  if (!ccy) return "\u2014";
  const sym = getCurrencySymbol(ccy) || `${ccy} `;
  if (major == null || !Number.isFinite(major)) return "\u2014";
  const x = Number(major.toFixed(2));
  const s = x.toFixed(2);
  // Drop leading zero before decimal only when integer part is zero (matches FM trim loosely)
  return `${sym}${s}`;
}
import { DRIVER_NEW_RIDE_OFFER_BODY } from "./negotiationPushCopy.ts";
export function rideOfferAlertPushBody(_trip) {
  return DRIVER_NEW_RIDE_OFFER_BODY;
}
export function fareAmountPlainStringFromTrip(trip) {
  const major = majorFareUnitFromTrip(trip);
  if (major == null || !Number.isFinite(major)) return "";
  return major.toFixed(2);
}
export function tripReferenceForRideOfferPush(trip) {
  const tn = typeof trip.trip_number === "string" ? trip.trip_number.trim() : trip.trip_number != null ? String(trip.trip_number).trim() : "";
  if (tn.length > 0) return tn;
  const id = typeof trip.id === "string" ? trip.id : "";
  return id.length >= 8 ? id.slice(0, 8) : id;
}
