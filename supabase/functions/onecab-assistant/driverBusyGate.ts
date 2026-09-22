/**
 * Deterministic Driver Assistant busy-workflow gate.
 *
 * Reuses existing trip / offer / stacked / scheduled statuses — does not invent
 * a second has_active_trip flag. The AI never decides this.
 */

import {
  isRestoreActiveTripStatus,
  isRestoreTerminalTripStatus,
  normalizeRestoreTripStatus,
} from "../_shared/activeTripRestoreSSOT.ts";
import { isScheduledInstantConversionPending } from "../_shared/scheduledHandoverHoldLock.ts";

export const DRIVER_ASSISTANT_UNAVAILABLE_DURING_TRIP =
  "DRIVER_ASSISTANT_UNAVAILABLE_DURING_TRIP";

/** Live ride_offers rows the Driver app still presents as an incoming offer. */
export const LIVE_RIDE_OFFER_STATUSES = ["pending", "countered"] as const;

export type DriverAssistantBusySnapshot = {
  liveOffer: boolean;
  assignedOrActiveTrip: boolean;
  stackedTrip: boolean;
  scheduledActivating: boolean;
  completionUnfinished: boolean;
};

export function isDriverAssistantBusy(snapshot: DriverAssistantBusySnapshot): boolean {
  return (
    snapshot.liveOffer ||
    snapshot.assignedOrActiveTrip ||
    snapshot.stackedTrip ||
    snapshot.scheduledActivating ||
    snapshot.completionUnfinished
  );
}

export function isLiveRideOfferStatus(status: string | null | undefined): boolean {
  const s = normalizeRestoreTripStatus(status);
  return (LIVE_RIDE_OFFER_STATUSES as readonly string[]).includes(s);
}

export function isAssignedOrActiveDriverTripStatus(status: string | null | undefined): boolean {
  const s = normalizeRestoreTripStatus(status);
  if (!s || isRestoreTerminalTripStatus(s)) return false;
  return isRestoreActiveTripStatus(s, "driver");
}

export function isStackedQueuedTripStatus(status: string | null | undefined): boolean {
  return normalizeRestoreTripStatus(status) === "queued";
}

export function isUnfinishedCompletionStatus(status: string | null | undefined): boolean {
  const s = normalizeRestoreTripStatus(status);
  return s === "completing";
}

const SCHEDULED_ACTIVATING_STATUSES = new Set([
  "scheduled_committed",
  "pending",
  "searching",
  "offered",
  "offering",
  "broadcasting",
  "searching_new_driver",
  "negotiating",
  "dispatching",
]);

function scheduledWindowReached(row: Record<string, unknown>, nowMs: number): boolean {
  const scheduledStatus = String(row.scheduled_status ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  // Preconfirm / HELD are reserved — not yet activating for Driver busy gate.
  // awaiting_activation_accept is activation-armed and should still count.
  if (
    scheduledStatus === "admin_held" ||
    scheduledStatus === "driver_assigned"
  ) {
    return false;
  }
  for (const key of ["scheduled_broadcast_at", "scheduled_convert_at", "scheduled_at"]) {
    const raw = row[key];
    if (typeof raw === "string") {
      const ms = new Date(raw).getTime();
      if (Number.isFinite(ms) && ms <= nowMs) return true;
    }
  }
  return false;
}

export function isScheduledJobActivating(
  row: {
    status?: string | null;
    booking_type?: string | null;
    trip_type?: string | null;
    is_scheduled?: boolean | null;
    scheduled_status?: string | null;
    dispatch_mode?: string | null;
    scheduled_at?: string | null;
    scheduled_broadcast_at?: string | null;
    scheduled_convert_at?: string | null;
    driver_id?: string | null;
    confirmed_driver_id?: string | null;
  },
  nowMs = Date.now(),
): boolean {
  const scheduledStatus = String(row.scheduled_status ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  // Admin HELD / marketplace preconfirm — not an active Driver workflow yet.
  if (scheduledStatus === "admin_held" || scheduledStatus === "driver_assigned") {
    return false;
  }
  // Activation NRO pending Accept → Drive to Pickup.
  if (scheduledStatus === "awaiting_activation_accept") {
    return true;
  }
  const status = normalizeRestoreTripStatus(row.status);
  if (status === "scheduled_committed") return true;
  const hasDriver = Boolean(row.driver_id || row.confirmed_driver_id);
  if (!hasDriver) return false;
  if (!isScheduledInstantConversionPending(row)) return false;
  if (SCHEDULED_ACTIVATING_STATUSES.has(status) && scheduledWindowReached(row, nowMs)) {
    return true;
  }
  return false;
}

export function evaluateDriverAssistantBusyFromRows(args: {
  offers: Array<{ status?: string | null; expires_at?: string | null }>;
  trips: Array<{
    status?: string | null;
    booking_type?: string | null;
    trip_type?: string | null;
    is_scheduled?: boolean | null;
    scheduled_status?: string | null;
    driver_id?: string | null;
    confirmed_driver_id?: string | null;
  }>;
  nowMs?: number;
}): DriverAssistantBusySnapshot {
  const nowMs = args.nowMs ?? Date.now();
  const liveOffer = args.offers.some((offer) => {
    if (!isLiveRideOfferStatus(offer.status)) return false;
    if (typeof offer.expires_at === "string") {
      const ms = new Date(offer.expires_at).getTime();
      if (Number.isFinite(ms) && ms <= nowMs) return false;
    }
    return true;
  });

  let assignedOrActiveTrip = false;
  let stackedTrip = false;
  let scheduledActivating = false;
  let completionUnfinished = false;

  for (const trip of args.trips) {
    if (isStackedQueuedTripStatus(trip.status)) stackedTrip = true;
    if (isUnfinishedCompletionStatus(trip.status)) completionUnfinished = true;
    if (isAssignedOrActiveDriverTripStatus(trip.status)) assignedOrActiveTrip = true;
    if (isScheduledJobActivating(trip, nowMs)) scheduledActivating = true;
  }

  return {
    liveOffer,
    assignedOrActiveTrip,
    stackedTrip,
    scheduledActivating,
    completionUnfinished,
  };
}
