/**
 * Mirrors `public.ride_offer_build_send_notification_body` OS alert copy + helpers
 * for Edge Functions that send ride-offer pushes outside the INSERT trigger path.
 *
 * Killed-state OS title/body are fixed approved strings — never fare/pickup.
 */

import { getCurrencySymbol } from './currency.ts';
import { resolveTripDisplayFare } from './tripDisplayFareSSOT.ts';
import {
  DRIVER_NEW_RIDE_OFFER_BODY,
  DRIVER_NEW_RIDE_OFFER_TITLE,
} from './negotiationPushCopy.ts';

/**
 * iOS APNs `aps.sound` — must match mono CAF/WAV in Driver Copy Bundle Resources.
 * Known mismatch (fixed in send-driver-notification): previously hardcoded
 * `onecab_true_original_refined.wav` — production now uses this constant.
 */
export const RIDE_OFFER_IOS_ALERT_SOUND = 'onecab_new_ride_offer.wav';

/** Approved Android channel (native SSOT). */
export const RIDE_OFFER_ANDROID_CHANNEL_ID = 'onecab_new_ride_offers_v1';

export { DRIVER_NEW_RIDE_OFFER_TITLE, DRIVER_NEW_RIDE_OFFER_BODY };

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  }
  return null;
}

/**
 * Pickup summary for **data payload only** (not OS alert body).
 * Empty → Tap to view details.
 */
export function pickupSummaryForRideOfferPush(
  pickupAddress: string | null | undefined,
): string {
  const t = (pickupAddress ?? '').trim();
  if (!t) return DRIVER_NEW_RIDE_OFFER_BODY;
  return t.length <= 160 ? t : t.slice(0, 160);
}

/**
 * Passenger fare amount in major units — uses resolveTripDisplayFare SSOT.
 * For data / card hydrate only — never OS title/body.
 */
export function majorFareUnitFromTrip(trip: Record<string, unknown>): number | null {
  const resolved = resolveTripDisplayFare(trip);
  if (resolved.payable_pence > 0) return resolved.payable_major;

  const fare = num(trip.fare);
  const estimatedFare = num(trip.estimated_fare);
  const finalPence = num(trip.final_fare_pence);
  const grossPence = num(trip.gross_fare_pence);
  const estimatedTotalPence = num(trip.estimated_total_pence);

  let major =
    (finalPence != null ? finalPence / 100 : null) ??
    fare ??
    estimatedFare ??
    (grossPence != null ? grossPence / 100 : null) ??
    (estimatedTotalPence != null ? estimatedTotalPence / 100 : null);

  if (major == null || !Number.isFinite(major)) return null;

  if (major >= 500 && fare == null && estimatedFare == null) {
    major = major / 100;
  }
  return major;
}

export function fareDisplayForRideOfferPush(
  currencyCode: string | null | undefined,
  major: number | null,
): string {
  const ccy = String(currencyCode ?? '').trim().toUpperCase();
  if (!ccy) return '\u2014';
  const sym = getCurrencySymbol(ccy) || `${ccy} `;
  if (major == null || !Number.isFinite(major)) return '\u2014';
  const x = Number(major.toFixed(2));
  const s = x.toFixed(2);
  return `${sym}${s}`;
}

/** Approved OS alert body (no fare / address). */
export function rideOfferAlertPushBody(_trip?: Record<string, unknown>): string {
  return DRIVER_NEW_RIDE_OFFER_BODY;
}

/** Approved OS alert title. */
export function rideOfferAlertPushTitle(): string {
  return DRIVER_NEW_RIDE_OFFER_TITLE;
}

export function fareAmountPlainStringFromTrip(trip: Record<string, unknown>): string {
  const major = majorFareUnitFromTrip(trip);
  if (major == null || !Number.isFinite(major)) return '';
  return major.toFixed(2);
}

export function tripReferenceForRideOfferPush(trip: Record<string, unknown>): string {
  const tn =
    typeof trip.trip_number === 'string'
      ? trip.trip_number.trim()
      : trip.trip_number != null
        ? String(trip.trip_number).trim()
        : '';
  if (tn.length > 0) return tn;
  const id = typeof trip.id === 'string' ? trip.id : '';
  return id.length >= 8 ? id.slice(0, 8) : id;
}
