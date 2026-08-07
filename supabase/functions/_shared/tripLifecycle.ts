/**
 * Canonical trip lifecycle SSOT — passenger, driver, dispatch, stop-workflow.
 *
 * Core rule: Accept assigns a driver — it does NOT start the trip.
 * Trip start requires arrive-at-pickup → start_trip → in_progress.
 */

export type CanonicalTripLifecycleState =
  | "OFFERED"
  | "ACCEPTED"
  | "DRIVER_ASSIGNED"
  | "EN_ROUTE_TO_PICKUP"
  | "ARRIVED_AT_PICKUP"
  | "IN_PROGRESS"
  | "EN_ROUTE_TO_STOP"
  | "ARRIVED_AT_STOP"
  | "EN_ROUTE_TO_DESTINATION"
  | "ARRIVED_AT_DESTINATION"
  | "COMPLETED"
  | "CANCELLED"
  | "EXPIRED"
  | "TAKEN_BY_OTHER_DRIVER";

export type TripLifecycleAction =
  | "accept_offer"
  | "accept_fare"
  | "accept_standard"
  | "accept_stacked"
  | "start_journey_to_pickup"
  | "arrive_pickup"
  | "start_trip"
  | "arrive_stop"
  | "drive_to_next"
  | "continue_journey"
  | "complete_trip"
  | "cancel_trip";

export type TripStopRecord = {
  stop_index: number;
  type: "pickup" | "stop" | "dropoff";
  status: "pending" | "current" | "completed" | "skipped";
  arrived_at?: string | null;
};

export type TripLifecycleTripFields = {
  status?: string | null;
  started_at?: string | null;
  arrived_at?: string | null;
  completed_at?: string | null;
  current_stop_index?: number | null;
};

export type TripLifecycleValidationResult = {
  allowed: boolean;
  reason?: string;
  idempotent?: boolean;
  current_state?: CanonicalTripLifecycleState;
  next_state?: CanonicalTripLifecycleState;
};

const TERMINAL_DB = new Set([
  "completed",
  "cancelled",
  "canceled",
  "customer_cancelled",
  "driver_cancelled",
  "expired",
  "expired_no_driver",
  "declined",
  "no_show",
  "failed",
]);

const OFFERED_DB = new Set([
  "payment_pending",
  "pending",
  "searching",
  "offered",
  "offering",
  "broadcasting",
  "negotiating",
  "searching_new_driver",
]);

/** Assigned / accepted family. Production accept_ride_offer writes `driver_assigned`. */
const ASSIGNED_DB = new Set([
  "accepted",
  "confirmed",
  "driver_assigned",
  "queued",
]);

const EN_ROUTE_DB = new Set([
  "en_route",
  "en_route_to_pickup",
  "driver_en_route",
  "enroute_to_pickup",
  "driver_arriving",
]);

const ARRIVED_PICKUP_DB = new Set([
  "arrived",
  "arrived_pickup",
  "arrived_at_pickup",
  "at_pickup",
  "pickup_waiting",
  "waiting",
  "driver_arrived",
  "waiting_at_pickup",
]);

/** @deprecated Use ARRIVED_PICKUP_DB via isTripArrivedAtPickupDbStatus — kept for client imports. */
export const ARRIVED_AT_PICKUP_DB_STATUSES = ARRIVED_PICKUP_DB;

export const isTripArrivedAtPickupDbStatus = (status: string | null | undefined): boolean =>
  status != null && ARRIVED_PICKUP_DB.has(normalizeTripLifecycleDbStatus(status));

/** Statuses from which arrive-at-pickup is allowed (pre-pickup en route). */
export const CAN_ARRIVE_AT_PICKUP_FROM_DB_STATUSES = new Set([
  "driver_assigned",
  "accepted",
  "confirmed",
  "en_route",
  "en_route_to_pickup",
  "driver_en_route",
  "enroute_to_pickup",
  "driver_arriving",
  "queued",
]);

const IN_PROGRESS_DB = new Set([
  "in_progress",
  "on_trip",
  "started",
  "ongoing",
  "completing",
  "passenger_onboard",
]);

export function normalizeTripLifecycleDbStatus(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toLowerCase().replace(/-/g, "_");
}

export function isTerminalTripLifecycleStatus(raw: string | null | undefined): boolean {
  const s = normalizeTripLifecycleDbStatus(raw);
  if (!s) return false;
  if (TERMINAL_DB.has(s)) return true;
  return s.includes("cancelled") || s.includes("canceled");
}

export function countIntermediateStops(stops: TripStopRecord[]): number {
  return stops.filter((s) => s.type === "stop").length;
}

export function hasPendingIntermediateStops(stops: TripStopRecord[]): boolean {
  return stops.some(
    (s) => s.type === "stop" && s.status !== "completed" && s.status !== "skipped",
  );
}

export function isAtFinalDestination(stops: TripStopRecord[], currentIndex: number): boolean {
  const dropoff = stops.find((s) => s.type === "dropoff");
  if (!dropoff) return false;
  if (dropoff.status === "current") return true;
  if (currentIndex >= dropoff.stop_index) {
    return dropoff.status !== "completed" && dropoff.status !== "skipped";
  }
  return false;
}

/** Resolve canonical lifecycle state from DB trip row + stops. */
export function resolveCanonicalTripLifecycleState(
  trip: TripLifecycleTripFields,
  stops: TripStopRecord[] = [],
): CanonicalTripLifecycleState {
  const status = normalizeTripLifecycleDbStatus(trip.status);
  const started = !!trip.started_at;
  const currentIndex = trip.current_stop_index ?? 0;

  if (status === "completed" || trip.completed_at) return "COMPLETED";
  if (
    status.includes("cancelled") ||
    status.includes("canceled") ||
    status === "declined" ||
    status === "no_show" ||
    status === "failed"
  ) {
    return "CANCELLED";
  }
  if (status === "expired" || status === "expired_no_driver") return "EXPIRED";

  if (started || IN_PROGRESS_DB.has(status)) {
    const pendingIntermediate = hasPendingIntermediateStops(stops);
    const currentStop = stops.find((s) => s.stop_index === currentIndex)
      ?? stops.find((s) => s.status === "current");

    if (currentStop?.type === "stop") {
      if (currentStop.status === "current" && currentStop.arrived_at) return "ARRIVED_AT_STOP";
      if (currentStop.status === "current") return "EN_ROUTE_TO_STOP";
    }

    if (isAtFinalDestination(stops, currentIndex)) {
      const dropoff = stops.find((s) => s.type === "dropoff");
      if (dropoff?.status === "current" && dropoff.arrived_at) return "ARRIVED_AT_DESTINATION";
      return "EN_ROUTE_TO_DESTINATION";
    }

    if (pendingIntermediate) return "EN_ROUTE_TO_STOP";
    return "IN_PROGRESS";
  }

  if (ARRIVED_PICKUP_DB.has(status) || trip.arrived_at) return "ARRIVED_AT_PICKUP";
  if (EN_ROUTE_DB.has(status)) return "EN_ROUTE_TO_PICKUP";
  if (ASSIGNED_DB.has(status)) return "DRIVER_ASSIGNED";
  if (OFFERED_DB.has(status)) return "OFFERED";

  return "OFFERED";
}

/** Stop progression rules for 0 / 1 / 2+ intermediate stops. */
export function validateTripStopsProgression(
  action: TripLifecycleAction,
  trip: TripLifecycleTripFields,
  stops: TripStopRecord[],
): TripLifecycleValidationResult {
  const intermediateCount = countIntermediateStops(stops);
  const state = resolveCanonicalTripLifecycleState(trip, stops);
  const hasDropoff = stops.some((s) => s.type === "dropoff");
  const pendingIntermediate = hasPendingIntermediateStops(stops);

  if (action === "start_trip") {
    if (state !== "ARRIVED_AT_PICKUP") {
      return { allowed: false, reason: "Start trip requires arrival at pickup first.", current_state: state };
    }
    const next: CanonicalTripLifecycleState = intermediateCount > 0
      ? "EN_ROUTE_TO_STOP"
      : "EN_ROUTE_TO_DESTINATION";
    return { allowed: true, current_state: state, next_state: next };
  }

  if (action === "arrive_stop") {
    if (!pendingIntermediate) {
      return { allowed: false, reason: "No intermediate stop to arrive at.", current_state: state };
    }
    return { allowed: true, current_state: state, next_state: "ARRIVED_AT_STOP" };
  }

  if (action === "drive_to_next" || action === "continue_journey") {
    if (pendingIntermediate) {
      return { allowed: true, current_state: state, next_state: "EN_ROUTE_TO_STOP" };
    }
    if (hasDropoff) {
      return { allowed: true, current_state: state, next_state: "EN_ROUTE_TO_DESTINATION" };
    }
    return { allowed: false, reason: "No next destination.", current_state: state };
  }

  if (action === "complete_trip") {
    if (pendingIntermediate) {
      return {
        allowed: false,
        reason: "Complete trip blocked — intermediate stops remain.",
        current_state: state,
      };
    }
    if (!hasDropoff) {
      return { allowed: false, reason: "Final destination not found.", current_state: state };
    }
    if (!trip.started_at) {
      return { allowed: false, reason: "Trip not started yet.", current_state: state };
    }
    return { allowed: true, current_state: state, next_state: "COMPLETED" };
  }

  return { allowed: true, current_state: state };
}

/** Canonical transition validator for lifecycle actions. */
export function validateTripActionTransition(
  action: TripLifecycleAction,
  trip: TripLifecycleTripFields,
  stops: TripStopRecord[] = [],
): TripLifecycleValidationResult {
  const state = resolveCanonicalTripLifecycleState(trip, stops);
  const status = normalizeTripLifecycleDbStatus(trip.status);

  if (action === "start_trip" && trip.started_at) {
    return { allowed: true, idempotent: true, current_state: state, next_state: "IN_PROGRESS" };
  }
  if (action === "complete_trip" && status === "completed") {
    return { allowed: true, idempotent: true, current_state: "COMPLETED", next_state: "COMPLETED" };
  }

  // Belt-and-suspenders: TERMINAL_DB statuses must never progress.
  if (
    isTerminalTripLifecycleStatus(trip.status) &&
    state !== "COMPLETED" &&
    action !== "cancel_trip"
  ) {
    if (status === "completed") {
      return { allowed: true, idempotent: true, current_state: "COMPLETED", next_state: "COMPLETED" };
    }
    return {
      allowed: false,
      reason: `Trip is terminal (${status || state.toLowerCase()}); action ${action} is not allowed.`,
      current_state: state === "OFFERED" ? "CANCELLED" : state,
    };
  }

  if (state === "COMPLETED" || state === "CANCELLED" || state === "EXPIRED") {
    return {
      allowed: false,
      reason: `Trip is ${state.toLowerCase()}; action ${action} is not allowed.`,
      current_state: state,
    };
  }

  const acceptActions = new Set<TripLifecycleAction>([
    "accept_offer",
    "accept_fare",
    "accept_standard",
    "accept_stacked",
  ]);

  if (acceptActions.has(action)) {
    if (state === "DRIVER_ASSIGNED" || state === "ARRIVED_AT_PICKUP" || state === "IN_PROGRESS") {
      return { allowed: false, reason: "Trip already accepted.", current_state: state };
    }
    if (state === "TAKEN_BY_OTHER_DRIVER") {
      return { allowed: false, reason: "Offer no longer available.", current_state: state };
    }
    return { allowed: true, current_state: state, next_state: "DRIVER_ASSIGNED" };
  }

  if (action === "arrive_pickup") {
    const allowedFrom = new Set<CanonicalTripLifecycleState>([
      "DRIVER_ASSIGNED",
      "EN_ROUTE_TO_PICKUP",
      "ACCEPTED",
      "OFFERED",
    ]);
    if (state === "ARRIVED_AT_PICKUP") {
      return { allowed: true, idempotent: true, current_state: state, next_state: state };
    }
    if (trip.started_at || state === "IN_PROGRESS") {
      return { allowed: false, reason: "Trip already started; cannot arrive at pickup.", current_state: state };
    }
    if (!allowedFrom.has(state)) {
      return { allowed: false, reason: `Cannot arrive at pickup from ${state}.`, current_state: state };
    }
    return { allowed: true, current_state: state, next_state: "ARRIVED_AT_PICKUP" };
  }

  if (action === "start_trip") {
    if (state === "DRIVER_ASSIGNED" || state === "EN_ROUTE_TO_PICKUP") {
      return {
        allowed: false,
        reason: "Cannot start trip before arriving at pickup.",
        current_state: state,
      };
    }
    return validateTripStopsProgression(action, trip, stops);
  }

  if (action === "complete_trip") {
    if (state === "DRIVER_ASSIGNED" || state === "EN_ROUTE_TO_PICKUP" || state === "ARRIVED_AT_PICKUP") {
      return {
        allowed: false,
        reason: "Cannot complete trip before it has started.",
        current_state: state,
      };
    }
    if (state === "OFFERED" || state === "ACCEPTED") {
      return {
        allowed: false,
        reason: "Cannot complete trip before pickup.",
        current_state: state,
      };
    }
    return validateTripStopsProgression(action, trip, stops);
  }

  if (action === "arrive_stop" || action === "drive_to_next" || action === "continue_journey") {
    if (!trip.started_at && state !== "IN_PROGRESS" && state !== "EN_ROUTE_TO_STOP" && state !== "ARRIVED_AT_STOP") {
      return { allowed: false, reason: "Trip not in progress.", current_state: state };
    }
    return validateTripStopsProgression(action, trip, stops);
  }

  if (action === "start_journey_to_pickup") {
    if (state === "DRIVER_ASSIGNED" || state === "EN_ROUTE_TO_PICKUP") {
      return { allowed: true, current_state: state, next_state: "EN_ROUTE_TO_PICKUP" };
    }
    return { allowed: false, reason: `Cannot start journey from ${state}.`, current_state: state };
  }

  if (action === "cancel_trip") {
    return { allowed: true, current_state: state, next_state: "CANCELLED" };
  }

  return { allowed: true, current_state: state };
}

/** All accept paths converge on DRIVER_ASSIGNED (accept does not start trip). */
export const ACCEPT_LIFECYCLE_ENTRY_ACTIONS: TripLifecycleAction[] = [
  "accept_offer",
  "accept_fare",
  "accept_standard",
  "accept_stacked",
];

export function isAcceptLifecycleAction(action: TripLifecycleAction): boolean {
  return ACCEPT_LIFECYCLE_ENTRY_ACTIONS.includes(action);
}

/** Map stop-workflow edge action names → canonical lifecycle actions. */
export function mapStopWorkflowActionToLifecycleAction(
  action: string,
): TripLifecycleAction | null {
  switch (action) {
    case "start_journey_to_pickup":
      return "start_journey_to_pickup";
    case "arrive_pickup":
      return "arrive_pickup";
    case "start_trip":
      return "start_trip";
    case "arrive_stop":
      return "arrive_stop";
    case "next_stop":
    case "drive_to_next":
      return "drive_to_next";
    case "complete_trip":
      return "complete_trip";
    case "driver_cancel":
    case "cancel_queued_stacked":
      return "cancel_trip";
    default:
      return null;
  }
}
