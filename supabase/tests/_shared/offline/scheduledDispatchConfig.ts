/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Scheduled dispatch config — global_dispatch_settings SSOT.
 * Admin Auto-Dispatch Rules UI writes this table; scheduled-dispatch reads it.
 *
 * Activation uses fixed Local/Long T-minutes (scheduledActivationSSOT).
 * Legacy ETA commitment activation is removed.
 */

import {
  resolveScheduledActivationConfig,
  type ScheduledActivationConfig,
} from "../../../functions/_shared/scheduledActivationSSOT.ts";

import { resolveNextRematchBroadcastRound } from "../../../functions/_shared/driverCancelRematch.ts";
import { ADMIN_HELD_SCHEDULED_STATUS, NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES, SCHEDULED_OPEN_JOB_TRIP_STATUSES } from "../../../functions/_shared/scheduledDispatchConfig.ts";


export function isAdminHeldScheduledStatus(
  scheduledStatus: string | null | undefined,
): boolean {
  return String(scheduledStatus ?? "").trim().toLowerCase() === ADMIN_HELD_SCHEDULED_STATUS;
}


export function isNoPreconfirmedConvertScheduledStatus(
  scheduledStatus: string | null | undefined,
): boolean {
  const status = String(scheduledStatus ?? "").toLowerCase();
  return (NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES as readonly string[]).includes(
    status,
  );
}


/**
 * True when auto-dispatch / Driver should treat this as an instant nearby offer.
 * Covers Scheduled → Urgent conversion AND broadcasting open jobs (heatmap).
 */
export function isOpenJobInstantRideOffer(trip: {
  dispatch_mode?: string | null;
  scheduled_status?: string | null;
  status?: string | null;
}): boolean {
  const mode = String(trip.dispatch_mode ?? "").toLowerCase();
  const scheduledStatus = String(trip.scheduled_status ?? "").toLowerCase();
  const status = String(trip.status ?? "").toLowerCase();
  if (mode === "instant" || scheduledStatus === "converted_to_instant") return true;
  return (SCHEDULED_OPEN_JOB_TRIP_STATUSES as readonly string[]).includes(status);
}


/**
 * Do not stomp scheduled marketplace rows to `searching` — that makes the
 * heat-map count an "open job" while Driver still diverts to Scheduled Jobs.
 */
export function nextAutoDispatchTripStatus(trip: {
  status?: string | null;
  dispatch_mode?: string | null;
  scheduled_status?: string | null;
}): string {
  if (String(trip.status ?? "") === "searching_new_driver") return "searching_new_driver";
  const scheduledMarketplace =
    String(trip.dispatch_mode ?? "") === "scheduled" &&
    String(trip.scheduled_status ?? "") !== "converted_to_instant";
  if (scheduledMarketplace) {
    const current = String(trip.status ?? "").toLowerCase();
    if (
      current === "offered" ||
      current === "broadcasting" ||
      current === "offering" ||
      current === "negotiating"
    ) {
      return current;
    }
    return "offered";
  }
  return "searching";
}

export * from "../../../functions/_shared/scheduledDispatchConfig.ts";
