/**
 * Shared pre-activation scheduled assignment release (Bug #22 + compliance).
 *
 * When a confirmed driver drops before JIT activation and before the unclaimed
 * urgent conversion deadline, reopen Requested marketplace — Make Available
 * shaped — never stamp Finding/instant (`offered` / `searching` / convert).
 */

import {
  buildMakeAvailableScheduledJobsPatch,
  buildBroadcastNowPatch,
} from "./scheduledAdminReleaseSSOT.ts";
import { shouldUseUrgentRescueForComplianceRelease } from "./scheduledJourneyComplianceSSOT.ts";

export type ScheduledPreActivationReleaseKind =
  | "marketplace_reopen"
  | "urgent_convert";

/** Same clock as compliance / unclaimed convert — NOT check_in_window_minutes. */
export function shouldUrgentConvertOnPreActivationRelease(input: {
  scheduledAtIso: string;
  nowMs?: number;
  urgentTriggerMinutesBeforePickup?: number;
}): boolean {
  return shouldUseUrgentRescueForComplianceRelease(input);
}

/**
 * Clear assignment-specific JIT / commitment / offer stamps.
 * Safe for both voluntary cancel and compliance release.
 */
export function clearScheduledAssignmentSpecificState(): Record<string, unknown> {
  return {
    driver_id: null,
    confirmed_driver_id: null,
    cancelled_at: null,
    cancelled_by: null,
    scheduled_driver_risk: false,
    current_offer_driver_id: null,
    current_offer_expires_at: null,
    commitment_time: null,
    scheduled_committed_at: null,
    scheduled_jit_activate_at: null,
    scheduled_jit_eta_minutes: null,
    scheduled_jit_eta_observed_at: null,
    scheduled_jit_distance_kind: null,
    scheduled_jit_eta_source: null,
    scheduled_jit_basis_scheduled_at: null,
    scheduled_jit_eta_spike_samples: 0,
    pending_release_kind: null,
    pending_release_at: null,
    pending_release_driver_id: null,
  };
}

/**
 * Non-urgent rematch: Requested marketplace (Driver Scheduled Jobs).
 * Customer must stay on Scheduled list — never `status=offered`.
 */
export function buildScheduledMarketplaceRematchPatch(input: {
  nowIso: string;
  broadcastAtIso: string;
  broadcastEnabled: boolean;
  /** Optional driver-facing cancel reason (voluntary cancel only). */
  cancellationReason?: string | null;
  cancellationNote?: string | null;
}): Record<string, unknown> {
  const rematchBroadcastEnabled = input.broadcastEnabled !== false;
  if (!rematchBroadcastEnabled) {
    return {
      ...clearScheduledAssignmentSpecificState(),
      scheduled_status: "admin_held",
      status: "scheduled",
      dispatch_mode: "scheduled",
      dispatch_status: "available",
      scheduled_broadcast_at: null,
      broadcast_enabled: false,
      scheduled_hold_reason: "airport_pricing",
      cancellation_reason: input.cancellationReason ?? null,
      cancellation_note: input.cancellationNote ?? null,
      updated_at: input.nowIso,
    };
  }
  // Make Available shape + broadcasting visibility for Requested tab.
  // status stays `scheduled` (Bug #22) — never `offered`.
  return {
    ...buildMakeAvailableScheduledJobsPatch({ nowIso: input.nowIso }),
    ...clearScheduledAssignmentSpecificState(),
    scheduled_status: "broadcasting",
    status: "scheduled",
    dispatch_mode: "scheduled",
    dispatch_status: "available",
    scheduled_broadcast_at: input.broadcastAtIso,
    broadcast_enabled: true,
    scheduled_hold_reason: "publication_pending",
    cancellation_reason: input.cancellationReason ?? null,
    cancellation_note: input.cancellationNote ?? null,
    updated_at: input.nowIso,
  };
}

export function buildScheduledUrgentRematchPatch(input: {
  nowIso: string;
  searchingExpiresAtIso: string;
  maxExistingBroadcastRound?: number | null;
  maxBroadcastSequences?: number | null;
  currentBroadcastEnabled?: boolean | null;
}): Record<string, unknown> {
  return {
    ...buildBroadcastNowPatch(input),
    ...clearScheduledAssignmentSpecificState(),
    updated_at: input.nowIso,
  };
}

export function resolvePreActivationReleaseKind(input: {
  scheduledAtIso: string;
  nowMs?: number;
  urgentTriggerMinutesBeforePickup?: number;
  broadcastEnabled?: boolean | null;
}): ScheduledPreActivationReleaseKind {
  const urgent = shouldUrgentConvertOnPreActivationRelease({
    scheduledAtIso: input.scheduledAtIso,
    nowMs: input.nowMs,
    urgentTriggerMinutesBeforePickup: input.urgentTriggerMinutesBeforePickup,
  });
  if (urgent && input.broadcastEnabled !== false) return "urgent_convert";
  return "marketplace_reopen";
}

