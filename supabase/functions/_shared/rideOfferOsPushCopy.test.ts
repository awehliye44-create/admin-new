/**
 * Killed-state NEW_RIDE_OFFER OS copy — no fare / address in title or body.
 */

import {
  DRIVER_NEW_RIDE_OFFER_BODY,
  DRIVER_NEW_RIDE_OFFER_TITLE,
} from './negotiationPushCopy.ts';
import {
  rideOfferOsPushBody,
  rideOfferOsPushTitle,
  rideOfferPushBodyDriverNet,
} from './driverOfferPushCopy.ts';

Deno.test('approved OS title and body constants', () => {
  if (DRIVER_NEW_RIDE_OFFER_TITLE !== 'New ride offer available near you!') {
    throw new Error(`bad title: ${DRIVER_NEW_RIDE_OFFER_TITLE}`);
  }
  if (DRIVER_NEW_RIDE_OFFER_BODY !== 'Tap to view details') {
    throw new Error(`bad body: ${DRIVER_NEW_RIDE_OFFER_BODY}`);
  }
});

Deno.test('helpers never embed fare into OS alert', () => {
  const body = rideOfferPushBodyDriverNet('GBP', 2150);
  if (body !== DRIVER_NEW_RIDE_OFFER_BODY) {
    throw new Error(`rideOfferPushBodyDriverNet must return static body, got: ${body}`);
  }
  if (body.includes('£') || body.includes('earn') || /\d/.test(body)) {
    throw new Error(`OS body leaked details: ${body}`);
  }
  if (rideOfferOsPushTitle() !== DRIVER_NEW_RIDE_OFFER_TITLE) {
    throw new Error('os push title mismatch');
  }
  if (rideOfferOsPushBody() !== DRIVER_NEW_RIDE_OFFER_BODY) {
    throw new Error('os push body mismatch');
  }
});
