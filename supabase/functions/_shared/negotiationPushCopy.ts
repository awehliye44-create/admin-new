/**
 * Shared Driver/Customer negotiation + ride-offer push titles/bodies.
 * Keep remote push title aligned with Driver OS copy (ONECAB DRIVER).
 */

export const CUSTOMER_NEW_FARE_OFFER_TITLE = "New fare offer";
export const CUSTOMER_NEW_FARE_OFFER_BODY =
  "Driver sent a new fare offer. Review before it expires.";

/** APNs / FCM alert title — matches Driver iOS OS notification identity. */
export const DRIVER_NEW_RIDE_OFFER_TITLE = "ONECAB DRIVER";

/**
 * Fallback body only — authoritative copy is built by
 * `ride_offer_build_send_notification_body` (driver-net + distance/ETA/pickup).
 */
export const DRIVER_NEW_RIDE_OFFER_BODY =
  "New ride offer — tap to view details.";

export const NEGOTIATION_OFFER_EXPIRED_TITLE = "Fare offer expired";
export const NEGOTIATION_OFFER_EXPIRED_BODY =
  "The fare offer timed out. Waiting for the next update.";
