/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Phase 3 — Automatic Scheduled Jobs marketplace publication.
 *
 * Create still stamps admin_held + null scheduled_broadcast_at (Hard Rule #1 create).
 * After payment-confirmed trip creation + fare enrich gates pass, publish via the
 * existing Make Available patch (scheduled_status=scheduled, broadcast_at=now).
 *
 * Reuses scheduledAdminReleaseSSOT + scheduled-dispatch STEP 0 jobs executor.
 * No parallel dispatch engine.
 */

import {
  buildMakeAvailableScheduledJobsPatch,
  buildPendingReleasePatch,
  type PendingReleaseKind,
} from "../../../functions/_shared/scheduledAdminReleaseSSOT.ts";

import {
  assertAirportPricingReady,
  AUTO_PUBLISH_ELIGIBLE_HOLD_REASONS,
  isAutoPublishEligibleHoldReason,
  normaliseScheduledHoldReason,
  type ScheduledHoldReason,
} from "../../../functions/_shared/scheduledMarketplaceHoldSSOT.ts";
import { ScheduledMarketplaceTripSnapshot, ScheduledMarketplaceHoldClass, lower, TERMINAL_STATUSES, isBlank, LIVE_STATUSES, isScheduledMarketplaceAlreadyPublished, isExceptionalManualBookingSource, isPrematureIdealBroadcastStamp } from "../../../functions/_shared/scheduledMarketplaceAutoPublishSSOT.ts";


/**
 * Dry-run / ops classification — first matching class wins.
 * Mirror of docs Phase 3 hold taxonomy (H0–H9).
 */
export function classifyScheduledMarketplaceHold(
  trip: ScheduledMarketplaceTripSnapshot,
  nowMs: number = Date.now(),
): {
  class: ScheduledMarketplaceHoldClass;
  proposedAction: "skip" | "auto_publish" | "review" | "already_ok";
  reason: string;
} {
  const status = lower(trip.status);
  const sched = lower(trip.scheduled_status);
  const mode = lower(trip.dispatch_mode);

  if (mode && mode !== "scheduled" && !trip.scheduled_at) {
    return { class: "not_scheduled", proposedAction: "skip", reason: "not_scheduled" };
  }
  if (
    trip.completed_at ||
    trip.cancelled_at ||
    TERMINAL_STATUSES.has(status) ||
    sched === "cancelled" ||
    sched === "expired" ||
    sched === "no_driver_found" ||
    sched === "converted_to_instant" ||
    (!isBlank(trip.driver_id) && LIVE_STATUSES.has(status))
  ) {
    return { class: "terminal_or_live", proposedAction: "skip", reason: "terminal_or_live" };
  }
  if (sched === "payment_gate_blocked") {
    return {
      class: "payment_gate_blocked",
      proposedAction: "skip",
      reason: "payment_or_capture_coverage",
    };
  }
  if (trip.broadcast_enabled === false && Number(trip.airport_charge_pence ?? 0) > 0) {
    return {
      class: "airport_pricing_hold",
      proposedAction: "skip",
      reason: "airport_fare_persist_hold",
    };
  }
  if (trip.broadcast_enabled === false) {
    return {
      class: "other_broadcast_disabled",
      proposedAction: "review",
      reason: "broadcast_enabled_false",
    };
  }
  const pendingKind = lower(trip.pending_release_kind);
  if (pendingKind === "assign" || pendingKind === "broadcast" || pendingKind === "jobs") {
    const at = trip.pending_release_at ? Date.parse(String(trip.pending_release_at)) : NaN;
    if (Number.isFinite(at)) {
      return {
        class: "exceptional_pending_release",
        proposedAction: "skip",
        reason: `pending_${pendingKind}_at_${trip.pending_release_at}`,
      };
    }
  }
  if (!isBlank(trip.confirmed_driver_id) && isBlank(trip.driver_id)) {
    return { class: "preconfirmed", proposedAction: "skip", reason: "already_assigned_preconfirm" };
  }
  if (isScheduledMarketplaceAlreadyPublished(trip, nowMs)) {
    return { class: "already_published", proposedAction: "already_ok", reason: "marketplace_open" };
  }
  if (isExceptionalManualBookingSource(trip.booking_source)) {
    return {
      class: "manual_admin_hold",
      proposedAction: "review",
      reason: "admin_manual_booking_source",
    };
  }
  if (sched === "admin_held" && isBlank(trip.scheduled_broadcast_at) && isBlank(trip.driver_id) &&
    isBlank(trip.confirmed_driver_id)) {
    return {
      class: "routine_admin_held",
      proposedAction: "auto_publish",
      reason: "routine_create_held",
    };
  }
  if (
    (sched === "scheduled" || sched === "pending" || sched === "") &&
    isBlank(trip.scheduled_broadcast_at) &&
    isBlank(trip.driver_id) &&
    isBlank(trip.confirmed_driver_id)
  ) {
    return {
      class: "legacy_unpublished",
      proposedAction: "auto_publish",
      reason: "legacy_null_broadcast_at",
    };
  }
  if (isPrematureIdealBroadcastStamp(trip, nowMs)) {
    return {
      class: "legacy_unpublished",
      proposedAction: "auto_publish",
      reason: "premature_ideal_broadcast_stamp",
    };
  }
  return { class: "already_published", proposedAction: "already_ok", reason: "no_hold" };
}

export * from "../../../functions/_shared/scheduledMarketplaceAutoPublishSSOT.ts";
