/**
 * Scheduled-origin driver cancel after Heading to Pickup / Arrived →
 * same-trip instant rematch via existing conversion + rematch SSOTs.
 */

import { buildExclusiveFailureConversionPatch } from "./scheduledActivationExclusiveSSOT.ts";
import { isScheduledInstantConversionPending } from "./scheduledHandoverHoldLock.ts";

export const DRIVER_CANCEL_AFTER_HEADING_ACK_REASON =
  "driver_cancel_after_heading_to_pickup";

export function normalizeDriverCancelReason(
  raw: string | null | undefined,
): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "driver_cancelled";
  // Cap length; preserve accident/breakdown wording for Admin/support.
  return trimmed.slice(0, 240);
}

export function isAccidentOrBreakdownCancelReason(reason: string): boolean {
  const r = reason.toLowerCase();
  return (
    r.includes("accident") ||
    r.includes("breakdown") ||
    r.includes("broken down") ||
    r.includes("vehicle fault") ||
    r.includes("mechanical")
  );
}

export function shouldConvertScheduledOriginOnDriverCancel(trip: {
  dispatch_mode?: string | null;
  scheduled_status?: string | null;
  is_scheduled?: boolean | null;
  scheduled_at?: string | null;
}): boolean {
  return isScheduledInstantConversionPending(trip);
}

/**
 * Merge exclusive conversion (instant + converted_to_instant + JIT/ack clear)
 * with rematch status searching_new_driver and cancelled-driver bookkeeping.
 */
export function buildScheduledOriginDriverCancelRematchPatch(input: {
  nowIso: string;
  searchingExpiresAtIso: string;
  maxExistingBroadcastRound: number;
  maxBroadcastSequences?: number | null;
  excludeDriverId: string;
  existingExcludedDriverIds?: unknown;
  existingCancelledDriverIds?: unknown;
  currentBroadcastEnabled?: boolean | null;
  cancelReason: string;
}): Record<string, unknown> {
  const excluded = Array.isArray(input.existingExcludedDriverIds)
    ? input.existingExcludedDriverIds.filter((x): x is string => typeof x === "string")
    : [];
  const cancelled = Array.isArray(input.existingCancelledDriverIds)
    ? input.existingCancelledDriverIds.filter((x): x is string => typeof x === "string")
    : [];
  const nextExcluded = [...new Set([...excluded, input.excludeDriverId])];
  const nextCancelled = cancelled.includes(input.excludeDriverId)
    ? cancelled
    : [...cancelled, input.excludeDriverId];

  const conversion = buildExclusiveFailureConversionPatch({
    nowIso: input.nowIso,
    searchingExpiresAtIso: input.searchingExpiresAtIso,
    excludeDriverId: input.excludeDriverId,
    existingExcludedDriverIds: nextExcluded,
    maxExistingBroadcastRound: input.maxExistingBroadcastRound,
    maxBroadcastSequences: input.maxBroadcastSequences,
    currentBroadcastEnabled: input.currentBroadcastEnabled,
    ackResolution: {
      status: "cancelled",
      reason: DRIVER_CANCEL_AFTER_HEADING_ACK_REASON,
    },
  });

  return {
    ...conversion,
    // Rematch SSOT — Customer Finding / searching_new_driver (not plain searching).
    status: "searching_new_driver",
    cancelled_by: "driver",
    cancel_reason: normalizeDriverCancelReason(input.cancelReason),
    cancelled_driver_ids: nextCancelled,
    excluded_driver_ids: nextExcluded,
    scheduled_accepted_at: null,
    previous_driver_id: input.excludeDriverId,
    // Preserve scheduled_at / is_scheduled / fare / payment columns (untouched).
  };
}

export function buildInstantOriginDriverCancelRematchPatch(input: {
  nowIso: string;
  searchingExpiresAtIso: string | null;
  rematchBroadcastRound: number;
  excludeDriverId: string;
  existingExcludedDriverIds?: unknown;
  existingCancelledDriverIds?: unknown;
  cancelReason: string;
}): Record<string, unknown> {
  const excluded = Array.isArray(input.existingExcludedDriverIds)
    ? input.existingExcludedDriverIds.filter((x): x is string => typeof x === "string")
    : [];
  const cancelled = Array.isArray(input.existingCancelledDriverIds)
    ? input.existingCancelledDriverIds.filter((x): x is string => typeof x === "string")
    : [];
  const nextExcluded = [...new Set([...excluded, input.excludeDriverId])];
  const nextCancelled = cancelled.includes(input.excludeDriverId)
    ? cancelled
    : [...cancelled, input.excludeDriverId];

  return {
    status: "searching_new_driver",
    dispatch_status: "broadcasting",
    broadcast_enabled: true,
    negotiation_status: null,
    negotiation_locked_until: null,
    driver_id: null,
    confirmed_driver_id: null,
    current_offer_driver_id: null,
    negotiation_owner_driver_id: null,
    cancelled_driver_ids: nextCancelled,
    excluded_driver_ids: nextExcluded,
    scheduled_accepted_at: null,
    cancelled_by: "driver",
    cancel_reason: normalizeDriverCancelReason(input.cancelReason),
    current_broadcast_round: input.rematchBroadcastRound,
    searching_expires_at: input.searchingExpiresAtIso,
    previous_driver_id: input.excludeDriverId,
    updated_at: input.nowIso,
  };
}

/** Statuses that may still rematch — CAS must re-check these at write time. */
export const DRIVER_CANCEL_REMATCH_CAS_STATUSES = [
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
