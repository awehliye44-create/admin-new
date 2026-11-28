/**
 * BR3 — Authoritative passenger booking lifecycle eligibility for schedule overlap.
 *
 * Terminal bookings must never participate in overlap windows. Status inventory is
 * the union of restore / dispatch / fee-capture / canonical-lookup terminals so we
 * do not patch only the statuses discovered in one incident.
 *
 * Prefer filtering at the DB select (PostgREST `not.in`) with the same set used by
 * pure helpers. Overlap duration / buffer policy is unchanged.
 */

/** Trip statuses that must not create or retain overlap restrictions. */
export const PASSENGER_OVERLAP_TERMINAL_TRIP_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "cancelled",
  "canceled",
  "customer_cancelled",
  "customer_canceled",
  "passenger_cancelled",
  "passenger_canceled",
  "admin_cancelled",
  "admin_canceled",
  "cancelled_by_admin",
  "canceled_by_admin",
  "driver_cancelled",
  "driver_canceled",
  "expired",
  "expired_no_driver",
  "no_driver",
  "no_driver_found",
  "no_show",
  "no-show",
  "failed",
  "declined",
  "discarded",
  "refunded",
  "released",
]);

/**
 * PostgREST `not.in` operand for trips.status overlap selects.
 * Example: `.not("status", "in", PASSENGER_OVERLAP_TERMINAL_STATUS_POSTGREST_LIST)`
 */
export const PASSENGER_OVERLAP_TERMINAL_STATUS_POSTGREST_LIST = `(${
  [...PASSENGER_OVERLAP_TERMINAL_TRIP_STATUSES].map((s) => `"${s}"`).join(",")
})`;

export function normalizePassengerOverlapTripStatus(
  status: string | null | undefined,
): string {
  return String(status ?? "").trim().toLowerCase();
}

/** True when the trip may still impose an overlap window. */
export function isPassengerOverlapEligibleTripStatus(
  status: string | null | undefined,
): boolean {
  const s = normalizePassengerOverlapTripStatus(status);
  if (!s) return false;
  return !PASSENGER_OVERLAP_TERMINAL_TRIP_STATUSES.has(s);
}

/** Inverse — terminal lifecycle → immediately ineligible for overlap. */
export function isPassengerOverlapTerminalTripStatus(
  status: string | null | undefined,
): boolean {
  const s = normalizePassengerOverlapTripStatus(status);
  if (!s) return true;
  return PASSENGER_OVERLAP_TERMINAL_TRIP_STATUSES.has(s);
}
