/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Scheduled exclusive activation NRO + automatic nearby fallback SSOT.
 *
 * - Arm only the confirmed driver with a real ride_offers row.
 * - Push is the standard RIDE_OFFER / NEW_RIDE_OFFER path (INSERT trigger +
 *   optional Edge send with offer_id) — never SCHEDULED_COMMITMENT alone.
 * - Decline / expiry → convert same trip_id to instant nearby auto-dispatch.
 * - Never treat push delivery failure as a decline.
 */

import {
  buildScheduledUrgentConversionPatch,
  resolveConversionBroadcastEnabled,
} from "../../../functions/_shared/scheduledDispatchConfig.ts";

import { DRIVER_NEW_RIDE_OFFER_DATA_TYPE } from "../../../functions/_shared/rideOfferClientPushData.ts";

import { DRIVER_NEW_RIDE_OFFER_TITLE } from "../../../functions/_shared/negotiationPushCopy.ts";

import { rideOfferPushBodyDriverNet } from "../../../functions/_shared/driverOfferPushCopy.ts";

import { RIDE_OFFER_IOS_ALERT_SOUND } from "../../../functions/_shared/rideOfferPushCopy.ts";

import { resolveCommittedOfferGross } from "../../../functions/_shared/committedBookingOfferFareSSOT.ts";


export function buildExclusiveActivationRideOfferPush(input: {
  offerId: string;
  tripId: string;
  driverId: string;
  netPence: number;
  expiresAtIso: string;
  pickupAddress?: string | null;
  dropoffAddress?: string | null;
  currencyCode?: string | null;
  tripReference?: string | null;
}): {
  type: "RIDE_OFFER";
  title: string;
  body: string;
  data: Record<string, string>;
} {
  const currency = String(input.currencyCode ?? "GBP").trim() || "GBP";
  const body = rideOfferPushBodyDriverNet(currency, input.netPence);
  return {
    type: "RIDE_OFFER",
    title: DRIVER_NEW_RIDE_OFFER_TITLE,
    body,
    data: {
      type: DRIVER_NEW_RIDE_OFFER_DATA_TYPE,
      notificationType: DRIVER_NEW_RIDE_OFFER_DATA_TYPE,
      offer_notification_type: "new_ride_offer",
      offer_id: input.offerId,
      offerId: input.offerId,
      requestId: input.offerId,
      trip_id: input.tripId,
      tripId: input.tripId,
      booking_id: input.tripId,
      driver_id: input.driverId,
      driverId: input.driverId,
      expires_at: input.expiresAtIso,
      expiresAt: input.expiresAtIso,
      sound: RIDE_OFFER_IOS_ALERT_SOUND,
      pickupAddress: String(input.pickupAddress ?? ""),
      dropoffAddress: String(input.dropoffAddress ?? ""),
      driver_earnings_pence: String(input.netPence),
      driver_net_preview_pence: String(input.netPence),
      currencyCode: currency,
      currency_code: currency,
      offer_kind: "scheduled",
      scheduled_status: "awaiting_activation_accept",
      ...(input.tripReference
        ? { trip_reference: input.tripReference, tripReference: input.tripReference }
        : {}),
    },
  };
}

export * from "../../../functions/_shared/scheduledActivationExclusiveSSOT.ts";
