/**
 * Deterministic Customer Assistant live-workflow gate.
 *
 * Reuses restore-active-trip SSOT statuses. Future inactive scheduled bookings
 * must not block Help & Support. The AI never decides this.
 */

import {
  isRestoreActiveTripStatus,
  isRestoreTerminalTripStatus,
  normalizeRestoreTripStatus,
  RESTORE_ASSIGNED_ACTIVE_STATUSES,
} from "../../../shared/activeTripRestoreSSOT.ts";
import {
  isScheduledHandoverOpenJobStatus,
  isScheduledInstantConversionPending,
  isScheduledWorkflowOrigin,
} from "../_shared/scheduledHandoverHoldLock.ts";

export const CUSTOMER_ASSISTANT_UNAVAILABLE_DURING_TRIP =
  "CUSTOMER_ASSISTANT_UNAVAILABLE_DURING_TRIP";

const SEARCHING_STATUSES = new Set([
  "pending",
  "searching",
  "offered",
  "offering",
  "broadcasting",
  "searching_new_driver",
  "driver_cancelled",
  "negotiating",
  "payment_pending",
]);

const ASSIGNED_ACTIVE_SET = new Set(
  RESTORE_ASSIGNED_ACTIVE_STATUSES as readonly string[],
);

export type CustomerAssistantBusySnapshot = {
  searchingOrNegotiating: boolean;
  assignedOrActiveTrip: boolean;
  stackedTrip: boolean;
  scheduledActivating: boolean;
  completionUnfinished: boolean;
  pendingRating: boolean;
};

export function isCustomerAssistantBusy(snapshot: CustomerAssistantBusySnapshot): boolean {
  return (
    snapshot.searchingOrNegotiating ||
    snapshot.assignedOrActiveTrip ||
    snapshot.stackedTrip ||
    snapshot.scheduledActivating ||
    snapshot.completionUnfinished ||
    snapshot.pendingRating
  );
}

function isScheduledTrip(row: Record<string, unknown>): boolean {
  const bookingType = String(row.booking_type ?? row.trip_type ?? "").toLowerCase();
  if (bookingType === "instant" || bookingType === "immediate") return false;
  if (bookingType === "scheduled") return true;
  return row.is_scheduled === true;
}

function scheduledDispatchWindowReached(row: Record<string, unknown>, nowMs: number): boolean {
  const dispatchMode = String(row.dispatch_mode ?? "").toLowerCase();
  if (dispatchMode === "instant") return true;
  for (const key of ["scheduled_broadcast_at", "scheduled_convert_at", "scheduled_at"]) {
    const raw = row[key];
    if (typeof raw === "string") {
      const ms = new Date(raw).getTime();
      if (Number.isFinite(ms) && ms <= nowMs) return true;
    }
  }
  return false;
}

/** Same restore candidate rule used by findCustomerActiveTrip. */
export function isCustomerAssistantLiveTrip(
  row: Record<string, unknown>,
  nowMs = Date.now(),
): boolean {
  const status = normalizeRestoreTripStatus(String(row.status ?? ""));
  if (!status || isRestoreTerminalTripStatus(status)) return false;
  if (SEARCHING_STATUSES.has(status) && !isScheduledInstantConversionPending(row)) {
    const expires = row.searching_expires_at;
    if (typeof expires === "string") {
      const ms = new Date(expires).getTime();
      if (Number.isFinite(ms) && nowMs >= ms && !isScheduledWorkflowOrigin(row)) {
        return false;
      }
    }
  }
  if (
    isScheduledInstantConversionPending(row) &&
    isScheduledHandoverOpenJobStatus(status)
  ) {
    return true;
  }
  if (!isRestoreActiveTripStatus(status, "customer")) return false;
  if (!isScheduledTrip(row)) return true;
  const hasDriver = Boolean(row.driver_id || row.confirmed_driver_id);
  if (hasDriver && ASSIGNED_ACTIVE_SET.has(status)) return true;
  if (status === "scheduled" || status === "scheduled_committed") {
    return hasDriver || scheduledDispatchWindowReached(row, nowMs);
  }
  return scheduledDispatchWindowReached(row, nowMs);
}

export function evaluateCustomerAssistantBusyFromRows(args: {
  trips: Array<Record<string, unknown>>;
  pendingRating: boolean;
  nowMs?: number;
}): CustomerAssistantBusySnapshot {
  const nowMs = args.nowMs ?? Date.now();
  let searchingOrNegotiating = false;
  let assignedOrActiveTrip = false;
  let stackedTrip = false;
  let scheduledActivating = false;
  let completionUnfinished = false;

  for (const trip of args.trips) {
    const status = normalizeRestoreTripStatus(String(trip.status ?? ""));
    if (status === "queued") stackedTrip = true;
    if (status === "completing") completionUnfinished = true;
    if (!isCustomerAssistantLiveTrip(trip, nowMs)) continue;
    if (SEARCHING_STATUSES.has(status)) searchingOrNegotiating = true;
    else assignedOrActiveTrip = true;
    if (isScheduledTrip(trip) && scheduledDispatchWindowReached(trip, nowMs)) {
      scheduledActivating = true;
    }
  }

  return {
    searchingOrNegotiating,
    assignedOrActiveTrip,
    stackedTrip,
    scheduledActivating,
    completionUnfinished,
    pendingRating: args.pendingRating === true,
  };
}
