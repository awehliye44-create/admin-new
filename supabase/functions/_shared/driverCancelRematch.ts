/**
 * Driver cancel before pickup → same ride_id rematch (searching_new_driver).
 * Shared by driver-cancel-before-pickup, ride-transition guard, and customer resume.
 *
 * Rematch applies for any assigned trip that has NOT started (in_progress) and is NOT terminal.
 * No-show remains terminal via pickup-no-show — never rematch.
 */

/** DB statuses eligible for driver-cancel rematch (pre trip start). */
export const PRE_PICKUP_DRIVER_REMATCH_DB_STATUSES = [
  "confirmed",
  "accepted",
  "driver_assigned",
  "en_route",
  "en_route_to_pickup",
  "driver_en_route",
  "enroute_to_pickup",
  "driver_arriving",
  "queued",
  "arrived",
  "arrived_pickup",
  "arrived_at_pickup",
  "at_pickup",
  "pickup_waiting",
  "waiting",
  "driver_arrived",
  "waiting_at_pickup",
] as const;

const TERMINAL_NO_REMATCH = new Set([
  "in_progress",
  "on_trip",
  "started",
  "ongoing",
  "completing",
  "completed",
  "cancelled",
  "canceled",
  "customer_cancelled",
  "customer_canceled",
  "no_show",
  "no-show",
  "expired",
  "expired_no_driver",
  "declined",
  "failed",
]);

export function isPrePickupDriverRematchEligibleDbStatus(
  status: string | null | undefined,
): boolean {
  if (!status?.trim()) return false;
  const normalized = status.trim().toLowerCase();
  if (TERMINAL_NO_REMATCH.has(normalized)) return false;
  return (PRE_PICKUP_DRIVER_REMATCH_DB_STATUSES as readonly string[]).includes(normalized);
}

export function buildSearchCycleId(
  tripId: string,
  broadcastRound: number | null | undefined,
  searchingExpiresAt: string | null | undefined,
): string {
  return `${tripId}:${broadcastRound ?? 0}:${searchingExpiresAt ?? "none"}`;
}

/**
 * Align rematch to the end of the current 3-wave cycle so the next
 * auto-dispatch sequence is W1 of a fresh cycle (UNIQUE trip+driver+round safe).
 */
export function resolveNextRematchBroadcastRound(
  maxExistingBroadcastRound: number | null | undefined,
): number {
  const maxRound =
    typeof maxExistingBroadcastRound === "number" && Number.isFinite(maxExistingBroadcastRound)
      ? Math.max(0, Math.floor(maxExistingBroadcastRound))
      : 0;
  return Math.floor((maxRound + 2) / 3) * 3;
}

/**
 * SSOT trip→driver assignment column (accept, hydrate, admin active trips).
 * Production schema does not expose trips.driver_id — never SELECT/UPDATE it on cancel/rematch paths.
 */
export const TRIP_ASSIGNED_DRIVER_COLUMN = "confirmed_driver_id" as const;

/** Safe trip columns for driver-cancel/rematch (no trips.driver_id). */
export const TRIP_CANCEL_REMATCH_SELECT =
  "id, status, stacked_trip_id, cancelled_driver_ids, excluded_driver_ids, passenger_id, confirmed_driver_id, scan_go, locked_driver_id, service_area_id, cancel_reason, cancelled_by, searching_expires_at, current_broadcast_round, dispatch_mode, scheduled_status, is_scheduled, scheduled_at";

export function logTripAssignedDriverFieldResolved(context: string): void {
  console.log("DRIVER_CANCEL_SCHEMA_DRIVER_FIELD_RESOLVED", JSON.stringify({
    field: TRIP_ASSIGNED_DRIVER_COLUMN,
    context,
    omitted_columns: ["trips.driver_id"],
  }));
}

export function getTripAssignedDriverId(
  trip: { confirmed_driver_id?: string | null },
): string | null {
  const id = trip.confirmed_driver_id;
  return typeof id === "string" && id.trim() ? id : null;
}

/** Trip row must be assigned to this driver via confirmed_driver_id. */
export function isDriverAssignedToTrip(
  trip: { confirmed_driver_id?: string | null },
  driverId: string,
): boolean {
  return getTripAssignedDriverId(trip) === driverId;
}

/** Clear assignment; null legacy driver_id when column exists (rematch must not leave stale driver_id). */
export function buildClearTripAssignmentPatch(): Record<string, null> {
  return {
    driver_id: null,
    confirmed_driver_id: null,
    current_offer_driver_id: null,
    negotiation_owner_driver_id: null,
  };
}

/**
 * Re-enable dispatch after driver cancel rematch.
 * Negotiation / accept paths may leave broadcast_enabled=false; auto-dispatch skips those trips.
 */
export function buildDriverCancelRematchBroadcastPatch(): Record<string, boolean | null> {
  return {
    broadcast_enabled: true,
    negotiation_status: null,
    negotiation_locked_until: null,
  };
}
