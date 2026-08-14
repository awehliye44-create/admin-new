/**
 * Visible OS heads-up copy for Driver NEW_RIDE_OFFER (killed / background).
 * Fare, pickup, destination and passenger details belong only in the full offer card.
 */

/** Approved FCM/APNs alert title. */
export const DRIVER_NEW_RIDE_OFFER_TITLE =
  'New ride offer available near you!';

/** Approved FCM/APNs alert body. */
export const DRIVER_NEW_RIDE_OFFER_BODY = 'Tap to view details';

export function formatNegotiationGbp(pence: number): string {
  return `£${(Math.max(0, Math.round(pence)) / 100).toFixed(2)}`;
}

export const CUSTOMER_NEW_FARE_OFFER_TITLE = 'New fare offer';
export function customerNewFareOfferBody(driverOfferPence: number): string {
  return `Driver offered ${formatNegotiationGbp(driverOfferPence)} — respond before it expires.`;
}
export const CUSTOMER_NEW_FARE_OFFER_BODY = customerNewFareOfferBody(0).replace(
  '£0.00',
  'a new fare',
);

export function customerCounterOfferPushBody(counterPence: number): string {
  return `Customer counter offer ${formatNegotiationGbp(counterPence)} — respond before it expires.`;
}

export const OFFER_ACCEPTED_ASSIGNED_TITLE = 'Offer accepted';
export const OFFER_ACCEPTED_ASSIGNED_BODY = 'Offer accepted — trip assigned.';

export const CUSTOMER_DECLINED_OFFER_TITLE = 'Offer declined';
export const CUSTOMER_DECLINED_OFFER_BODY = 'Customer declined your offer.';

export const DRIVER_ACCEPTED_COUNTER_TITLE = 'Counter accepted';
export const DRIVER_ACCEPTED_COUNTER_BODY = 'Driver accepted your counter offer.';

export const FINDING_ANOTHER_DRIVER_UPDATED_FARE_BODY =
  "We're finding another driver at your updated fare.";

export const NEGOTIATION_OFFER_EXPIRED_TITLE = 'Fare offer expired';
export const NEGOTIATION_OFFER_EXPIRED_BODY =
  'The fare offer timed out. Waiting for the next update.';
