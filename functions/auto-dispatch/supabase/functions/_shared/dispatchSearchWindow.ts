/**
 * Customer search window SSOT (searching_expires_at).
 * Waves may exhaust before the window ends; trips stay searchable until the deadline.
 *
 * Instant TTL must not start at scheduled booking created_at (MK-260817-006).
 * While scheduled→instant conversion is still pending, there is no instant
 * search deadline — conversion stamps searching_expires_at.
 */

import { coercePositiveInt } from "./dispatch-settings.ts";
import {
  isScheduledInstantConversionPending,
  isScheduledWorkflowOrigin,
} from "./scheduledHandoverHoldLock.ts";

export type TripSearchTiming = {
  searching_expires_at?: string | null;
  created_at?: string | null;
  dispatch_mode?: string | null;
  scheduled_status?: string | null;
  is_scheduled?: boolean | null;
  scheduled_at?: string | null;
};

export type DispatchSearchSettings = {
  max_driver_find_time_minutes?: unknown;
  global_timeout_minutes?: unknown;
};

function findMinutesFromSettings(settings: DispatchSearchSettings): number {
  return (
    coercePositiveInt(settings.max_driver_find_time_minutes) ??
    coercePositiveInt(settings.global_timeout_minutes) ??
    3
  );
}

/**
 * Instant search deadline, or null while scheduled handover has not converted.
 * Never uses scheduled booking created_at as the instant TTL origin.
 */
export function resolveCustomerSearchDeadlineMs(
  trip: TripSearchTiming,
  settings: DispatchSearchSettings,
  nowMs: number = Date.now(),
): number | null {
  // Instant TTL is invalid until scheduled→instant conversion completes.
  // Ignore any stale searching_expires_at stamp from booking/broadcast.
  if (isScheduledInstantConversionPending(trip)) {
    return null;
  }
  if (trip.searching_expires_at) {
    const parsed = Date.parse(trip.searching_expires_at);
    if (Number.isFinite(parsed)) return parsed;
  }
  const findMinutes = findMinutesFromSettings(settings);
  // Converted / scheduled-origin jobs without a stamped window must not fall
  // back to booking created_at — that is the MK-006 instant-TTL defect.
  if (isScheduledWorkflowOrigin(trip)) {
    return nowMs + findMinutes * 60_000;
  }
  if (trip.created_at) {
    const created = Date.parse(trip.created_at);
    if (Number.isFinite(created)) return created + findMinutes * 60_000;
  }
  return nowMs + findMinutes * 60_000;
}

export function isCustomerSearchWindowActive(
  trip: TripSearchTiming,
  settings: DispatchSearchSettings,
  nowMs: number = Date.now(),
): boolean {
  const deadlineMs = resolveCustomerSearchDeadlineMs(trip, settings, nowMs);
  if (deadlineMs == null) return true;
  return deadlineMs > nowMs;
}

/** True when waves are exhausted and the customer search window has ended. */
export function shouldExpireTripAfterWavesExhausted(
  trip: TripSearchTiming,
  settings: DispatchSearchSettings,
  nowMs: number = Date.now(),
): boolean {
  return !isCustomerSearchWindowActive(trip, settings, nowMs);
}

/**
 * Next absolute broadcast sequence for auto-dispatch.
 *
 * Sequences advance W1→W2→W3→(next round)W1… up to maxSequences (= max_dispatch_rounds × 3).
 * Trip TTL does NOT block sequence advancement; when sequences are exhausted and the
 * search window is still active, the caller waits (does not invent seq beyond max).
 */
export function resolveDispatchBroadcastRound(params: {
  storedRound: number;
  maxRounds: number;
  forceRebroadcast: boolean;
  searchWindowActive: boolean;
}): number {
  const { storedRound, maxRounds, forceRebroadcast } = params;
  const maxSequences = Math.max(1, Math.floor(maxRounds));
  if (!forceRebroadcast) {
    return storedRound + 1;
  }
  if (storedRound >= maxSequences) {
    return maxSequences;
  }
  return storedRound + 1;
}

/** @deprecated Token retained for log compatibility; means sequences exhausted, waiting TTL. */
export const WAVE3_NO_ELIGIBLE_LOG_TOKEN = "wave3_no_eligible_waiting_search_window" as const;
