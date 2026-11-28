/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Mirrors `public.ride_offer_build_send_notification_body` OS alert copy + helpers
 * for Edge Functions that send ride-offer pushes outside the INSERT trigger path.
 *
 * Killed-state OS title/body are fixed approved strings — never fare/pickup.
 */

import { getCurrencySymbol } from '../../../functions/_shared/currency.ts';

import { resolveTripDisplayFare } from '../../../functions/_shared/tripDisplayFareSSOT.ts';

import {
  DRIVER_NEW_RIDE_OFFER_BODY,
  DRIVER_NEW_RIDE_OFFER_TITLE,
} from '../../../functions/_shared/negotiationPushCopy.ts';


/** Approved Android channel (native SSOT). */
export const RIDE_OFFER_ANDROID_CHANNEL_ID = 'onecab_new_ride_offers_v3';

export * from "../../../functions/_shared/rideOfferPushCopy.ts";
