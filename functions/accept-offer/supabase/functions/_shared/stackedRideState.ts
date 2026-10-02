/**
 * Stacked ride lifecycle SSOT â backend state tokens.
 * Admin config: global_dispatch_settings via stackedRideConfig.ts
 * Lifecycle ops: stackedRideLifecycle.ts
 *
 * Hard rule: stacked ride !== intermediate stop.
 */

/** Canonical stacked ride lifecycle states (backend + driver UI). */
export const STACKED_RIDE_STATES = {
  stacked_offer: "stacked_offer",
  stacked_queued: "stacked_queued",
  stacked_accepted: "stacked_accepted",
  stacked_waiting_current_trip_completion: "stacked_waiting_current_trip_completion",
  stacked_ready_to_activate: "stacked_ready_to_activate",
  stacked_active: "stacked_active",
  stacked_completed: "stacked_completed",
  stacked_cancelled: "stacked_cancelled",
} as const;

export type StackedRideState = (typeof STACKED_RIDE_STATES)[keyof typeof STACKED_RIDE_STATES];

/** Forbidden conflation with multi-stop workflow â never assign these to stacked rides. */
export const FORBIDDEN_STACKED_STOP_STATES = [
  "stop_1",
  "next_stop",
  "intermediate_stop",
  "active_stop_index",
  "current_leg_type_stop",
  "drive_to_next",
  "waypoint_as_trip",
  "trip_stop_as_queued_ride",
] as const;

/** Map trips.status + link fields to stacked lifecycle state. */
export function resolveStackedRideState(input: {
  tripStatus: string | null | undefined;
  isStackedOffer?: boolean;
  parentStackedTripId?: string | null;
  driverCurrentTripId?: string | null;
  tripId: string;
}): StackedRideState | null {
  const status = String(input.tripStatus ?? "").trim().toLowerCase().replace(/-/g, "_");

  if (input.isStackedOffer && status === "pending") {
    return STACKED_RIDE_STATES.stacked_offer;
  }

  if (status === "queued") {
    if (input.parentStackedTripId) {
      return STACKED_RIDE_STATES.stacked_waiting_current_trip_completion;
    }
    return STACKED_RIDE_STATES.stacked_queued;
  }

  if (
    input.driverCurrentTripId === input.tripId
    && ["driver_assigned", "driver_en_route", "arrived_pickup", "in_progress"].includes(status)
  ) {
    return STACKED_RIDE_STATES.stacked_active;
  }

  if (status === "completed") return STACKED_RIDE_STATES.stacked_completed;
  if (["cancelled", "expired", "declined"].includes(status)) {
    return STACKED_RIDE_STATES.stacked_cancelled;
  }

  return null;
}
