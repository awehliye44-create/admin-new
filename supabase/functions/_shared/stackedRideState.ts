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

