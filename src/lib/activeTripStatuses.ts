/**
 * Trip statuses that should appear on Admin "Active Trips" and related ops views.
 * Aligned with drive-hub-buddy dispatch / stop-workflow / customer-live SSOT.
 * Excludes terminal: completed, cancelled, customer_cancelled, expired, declined.
 */
export const ACTIVE_TRIP_DB_STATUSES = [
  // Dispatch / search
  'pending',
  'broadcasting',
  'searching',
  'searching_new_driver',
  'offered',
  'offering',
  'negotiating',
  'driver_notified',
  'awaiting_driver_response',
  // Assigned / en route / at pickup
  'accepted',
  'confirmed',
  'driver_assigned',
  'assigned',
  'queued',
  'en_route',
  'en_route_to_pickup',
  'driver_en_route',
  'enroute_to_pickup',
  'driver_arriving',
  'arrived',
  'arrived_pickup',
  'arrived_at_pickup',
  'at_pickup',
  'pickup_waiting',
  'waiting',
  'waiting_at_pickup',
  // In trip (legacy aliases included)
  'in_progress',
  'started',
  'on_trip',
  'ongoing',
  'trip_started',
] as const;

export type ActiveTripDbStatus = (typeof ACTIVE_TRIP_DB_STATUSES)[number];

export function isActiveTripDbStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return (ACTIVE_TRIP_DB_STATUSES as readonly string[]).includes(status.toLowerCase());
}
