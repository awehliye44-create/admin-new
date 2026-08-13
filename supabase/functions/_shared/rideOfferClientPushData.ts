/**
 * Builds Driver-app FCM/APNs `data` for envelope type RIDE_OFFER.
 *
 * Backend routing envelope remains `RIDE_OFFER`.
 * Client semantic type must be `NEW_RIDE_OFFER` (Driver parseRideOfferNotificationData).
 * Never overwrite the nested client type with the envelope name.
 */

export const DRIVER_NEW_RIDE_OFFER_DATA_TYPE = 'NEW_RIDE_OFFER' as const;

export type RideOfferEnvelopeType = 'RIDE_OFFER';

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

/**
 * Merge incoming offer data with required client keys.
 * Preserves offer_id / trip_id / expires_at / driver_id / dispatch_attempt_id /
 * trip_reference when already present.
 */
export function buildRideOfferClientPushData(
  incomingData: Record<string, unknown>,
  options?: { envelopeType?: RideOfferEnvelopeType },
): Record<string, string> {
  const envelope = options?.envelopeType ?? 'RIDE_OFFER';
  const offerId =
    asString(incomingData.offerId || incomingData.offer_id || incomingData.requestId || incomingData.request_id);
  const tripId = asString(incomingData.tripId || incomingData.trip_id);
  const expiresAt = asString(incomingData.expiresAt || incomingData.expires_at);
  const sentAt = asString(incomingData.sentAt || incomingData.sent_at);
  const notificationVersion = asString(
    incomingData.notificationVersion ?? incomingData.notification_version ?? '1',
  );

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(incomingData)) {
    if (value == null) continue;
    out[key] = asString(value);
  }

  // Client semantic type — never the routing envelope.
  out.type = DRIVER_NEW_RIDE_OFFER_DATA_TYPE;
  out.notificationType = DRIVER_NEW_RIDE_OFFER_DATA_TYPE;
  out.offer_notification_type = asString(
    incomingData.offer_notification_type || 'new_ride_offer',
  );
  // Diagnostics only — does not replace data.type for the Driver parser.
  out.envelope_type = envelope;

  if (offerId) {
    out.offerId = offerId;
    out.offer_id = offerId;
    out.requestId = offerId;
  }
  if (tripId) {
    out.tripId = tripId;
    out.trip_id = tripId;
    out.booking_id = asString(incomingData.booking_id || tripId);
  }
  if (expiresAt) {
    out.expiresAt = expiresAt;
    out.expires_at = asString(incomingData.expires_at || expiresAt);
  }
  if (sentAt) {
    out.sentAt = sentAt;
  }
  if (notificationVersion) {
    out.notificationVersion = notificationVersion;
  }

  const driverId = asString(incomingData.driver_id || incomingData.driverId);
  if (driverId) {
    out.driver_id = driverId;
    out.driverId = driverId;
  }

  const dispatchAttemptId = asString(
    incomingData.dispatch_attempt_id || incomingData.dispatchAttemptId,
  );
  if (dispatchAttemptId) {
    out.dispatch_attempt_id = dispatchAttemptId;
    out.dispatchAttemptId = dispatchAttemptId;
  }

  const tripReference = asString(
    incomingData.trip_reference || incomingData.tripReference,
  );
  if (tripReference) {
    out.trip_reference = tripReference;
    out.tripReference = tripReference;
  }

  return out;
}
