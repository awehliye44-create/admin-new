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
} from "../_shared/activeTripRestoreSSOT.ts";
import { isScheduledUnassignedMarketplaceLive } from "../_shared/scheduledDispatchConfig.ts";
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

function marketplaceLive(row: Record<string, unknown>, nowMs: number): boolean {
  return isScheduledUnassignedMarketplaceLive({
    scheduledStatus: row.scheduled_status as string | null,
    driverId: row.driver_id as string | null,
    confirmedDriverId: row.confirmed_driver_id as string | null,
    scheduledBroadcastAt: row.scheduled_broadcast_at as string | null,
    scheduledConvertAt: row.scheduled_convert_at as string | null,
    scheduledAt: row.scheduled_at as string | null,
    nowMs,
  });
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
  const hasDriver = Boolean(row.driver_id || row.confirmed_driver_id);
  if (
    isScheduledInstantConversionPending(row) &&
    isScheduledHandoverOpenJobStatus(status)
  ) {
    if (hasDriver) return true;
    return marketplaceLive(row, nowMs);
  }
  if (!isRestoreActiveTripStatus(status, "customer")) return false;
  if (!isScheduledTrip(row)) return true;
  const dispatchMode = String(row.dispatch_mode ?? "").trim().toLowerCase();
  const scheduledStatus = String(row.scheduled_status ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (dispatchMode === "instant" || scheduledStatus === "converted_to_instant") {
    return true;
  }
  if (hasDriver && ASSIGNED_ACTIVE_SET.has(status)) return true;
  if (hasDriver && (status === "scheduled" || status === "scheduled_committed")) {
    return true;
  }
  return marketplaceLive(row, nowMs);
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
    if (isScheduledTrip(trip)) scheduledActivating = true;
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
