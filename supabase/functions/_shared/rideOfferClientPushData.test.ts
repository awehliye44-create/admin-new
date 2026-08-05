/**
 * Unit test for admin-new rideOfferClientPushData (copied logic assertions).
 * Run via: deno test supabase/functions/_shared/rideOfferClientPushData.test.ts
 */

import {
  assertEquals,
  assertNotEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  buildRideOfferClientPushData,
  DRIVER_NEW_RIDE_OFFER_DATA_TYPE,
} from './rideOfferClientPushData.ts';

Deno.test('RIDE_OFFER envelope keeps data.type=NEW_RIDE_OFFER', () => {
  const data = buildRideOfferClientPushData({
    type: 'NEW_RIDE_OFFER',
    offerId: 'offer-1',
    tripId: 'trip-1',
    expiresAt: '2026-08-04T20:04:24.860Z',
    sentAt: '2026-08-04T20:03:39.860Z',
    notificationVersion: '1',
    driver_id: 'driver-1',
    dispatch_attempt_id: 'da-1',
    trip_reference: 'MK-260804-022',
  });
  assertEquals(data.type, DRIVER_NEW_RIDE_OFFER_DATA_TYPE);
  assertEquals(data.notificationType, DRIVER_NEW_RIDE_OFFER_DATA_TYPE);
  assertEquals(data.envelope_type, 'RIDE_OFFER');
  assertNotEquals(data.type, 'RIDE_OFFER');
  assertEquals(data.offerId, 'offer-1');
  assertEquals(data.offer_id, 'offer-1');
  assertEquals(data.tripId, 'trip-1');
  assertEquals(data.trip_id, 'trip-1');
  assertEquals(data.driver_id, 'driver-1');
  assertEquals(data.dispatch_attempt_id, 'da-1');
  assertEquals(data.trip_reference, 'MK-260804-022');
  assertEquals(data.expiresAt, '2026-08-04T20:04:24.860Z');
});

Deno.test('does not keep incoming type=RIDE_OFFER as client semantic type', () => {
  const data = buildRideOfferClientPushData({
    type: 'RIDE_OFFER',
    offer_id: 'o2',
    trip_id: 't2',
  });
  assertEquals(data.type, 'NEW_RIDE_OFFER');
});
