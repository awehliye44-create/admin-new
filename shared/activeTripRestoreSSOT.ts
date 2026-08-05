/**
 * Active trip restore SSOT — customer + driver apps, restore-active-trip edge.
 * Backend trips.status is canonical; lifecycle_action guides driver UI affordances.
 */

export const RESTORE_TERMINAL_TRIP_STATUSES = new Set([
  "completed",
  "cancelled",
  "canceled",
  "customer_cancelled",
  "customer_canceled",
  "passenger_cancelled",
  "passenger_canceled",
  "driver_cancelled",
  "expired",
  "expired_no_driver",
  "no_driver",
  "no_show",
  "no-show",
  "failed",
  "declined",
  "refunded",
  "released",
]);

/** Post-assign + in-trip statuses (canonical driver progression). */
export const RESTORE_ASSIGNED_ACTIVE_STATUSES = [
  "accepted",
  "confirmed",
  "driver_assigned",
  "en_route",
  "en_route_to_pickup",
  "enroute_to_pickup",
  "driver_en_route",
  "driver_arriving",
  "arrived",
  "arrived_pickup",
  "arrived_at_pickup",
  "at_pickup",
  "pickup_waiting",
  "waiting",
  "waiting_at_pickup",
  "driver_arrived",
  "in_progress",
  "on_trip",
  "started",
  "ongoing",
  "completing",
  "arrived_at_stop",
  "drive_to_next_stop",
  "queued",
  "scheduled_committed",
] as const;

/** Customer restore also includes pre-assign search/payment phases. */
export const RESTORE_CUSTOMER_ACTIVE_STATUSES = [
  "payment_pending",
  "pending",
  "searching",
  "offered",
  "offering",
  "broadcasting",
  "negotiating",
  "driver_cancelled",
  "searching_new_driver",
  "scheduled",
  ...RESTORE_ASSIGNED_ACTIVE_STATUSES,
] as const;

export const RESTORE_DRIVER_ACTIVE_STATUSES = [...RESTORE_ASSIGNED_ACTIVE_STATUSES] as const;

export type RestoreActiveTripRole = "customer" | "driver";

export function normalizeRestoreTripStatus(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toLowerCase().replace(/-/g, "_");
}

export function isRestoreTerminalTripStatus(status: string | null | undefined): boolean {
  const s = normalizeRestoreTripStatus(status);
  if (!s) return false;
  if (RESTORE_TERMINAL_TRIP_STATUSES.has(s)) return true;
  return s.includes("cancelled") || s.includes("canceled");
}

export function isRestoreActiveTripStatus(
  status: string | null | undefined,
  role: RestoreActiveTripRole,
): boolean {
  const s = normalizeRestoreTripStatus(status);
  if (!s || isRestoreTerminalTripStatus(s)) return false;
  const list = role === "driver"
    ? RESTORE_DRIVER_ACTIVE_STATUSES
    : RESTORE_CUSTOMER_ACTIVE_STATUSES;
  if ((list as readonly string[]).includes(s)) return true;
  return role === "customer";
}

export type RestoreTripStopRow = {
  type?: string | null;
  status?: string | null;
  arrived_at?: string | null;
  stop_index?: number | null;
};

const ARRIVED_PICKUP_STATUSES = new Set([
  "arrived",
  "arrived_pickup",
  "arrived_at_pickup",
  "at_pickup",
  "pickup_waiting",
  "waiting",
  "waiting_at_pickup",
  "driver_arrived",
]);

const EN_ROUTE_PICKUP_STATUSES = new Set([
  "driver_assigned",
  "accepted",
  "confirmed",
  "en_route",
  "en_route_to_pickup",
  "enroute_to_pickup",
  "driver_en_route",
  "driver_arriving",
  "scheduled_committed",
]);

function normStopStatus(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toLowerCase();
}

function findCurrentStop(stops: RestoreTripStopRow[]): RestoreTripStopRow | null {
  const current = stops.find((s) => normStopStatus(s.status) === "current");
  if (current) return current;
  return stops.find((s) => {
    const st = normStopStatus(s.status);
    return st !== "completed" && st !== "skipped";
  }) ?? null;
}

/** Driver primary stop-workflow action implied by backend trip + stops SSOT. */
export function resolveLifecycleActionFromTrip(
  trip: {
    status?: string | null;
    started_at?: string | null;
    current_stop_index?: number | null;
  },
  stops: RestoreTripStopRow[] = [],
): string {
  const status = normalizeRestoreTripStatus(trip.status);
  if (status === "queued") return "queued";
  if (status === "completed") return "completed";

  if (!trip.started_at && EN_ROUTE_PICKUP_STATUSES.has(status)) {
    return "arrive_pickup";
  }
  if (!trip.started_at && ARRIVED_PICKUP_STATUSES.has(status)) {
    return "start_trip";
  }

  if (trip.started_at || status === "in_progress" || status === "on_trip" || status === "started") {
    const current = findCurrentStop(stops);
    if (!current) return "complete_trip";
    if (current.type === "dropoff") return "complete_trip";
    if (current.type === "pickup") return "start_trip";
    if (current.type === "stop") {
      const st = normStopStatus(current.status);
      if (current.arrived_at || st === "arrived") return "drive_to_next";
      return "arrive_stop";
    }
    return "complete_trip";
  }

  return status || "unknown";
}
