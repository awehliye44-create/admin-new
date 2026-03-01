/**
 * Unified trip display utilities.
 * Trip numbers use the service-area code format (e.g. MK001)
 * stored in `trip_number`. Falls back to legacy `trip_code` then UUID prefix.
 */

/** Return the best human-readable trip identifier */
export function getTripDisplayId(trip: {
  trip_number?: string | null;
  trip_code?: string | null;
  id: string;
}): string {
  return trip.trip_number || trip.trip_code || trip.id.slice(0, 8).toUpperCase();
}
