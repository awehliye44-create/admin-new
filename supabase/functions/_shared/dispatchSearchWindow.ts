/**
 * Customer search window SSOT (searching_expires_at).
 * Waves may exhaust before the window ends; trips stay searchable until the deadline.
 */

import { coercePositiveInt } from "./dispatch-settings.ts";

export type TripSearchTiming = {
  searching_expires_at?: string | null;
  created_at?: string | null;
};

export type DispatchSearchSettings = {
  max_driver_find_time_minutes?: unknown;
  global_timeout_minutes?: unknown;
};

export function resolveCustomerSearchDeadlineMs(
  trip: TripSearchTiming,
  settings: DispatchSearchSettings,
  nowMs: number = Date.now(),
): number {
  if (trip.searching_expires_at) {
    const parsed = Date.parse(trip.searching_expires_at);
    if (Number.isFinite(parsed)) return parsed;
  }
  const findMinutes =
    coercePositiveInt(settings.max_driver_find_time_minutes) ??
    coercePositiveInt(settings.global_timeout_minutes) ??
    3;
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
  return resolveCustomerSearchDeadlineMs(trip, settings, nowMs) > nowMs;
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
 * Next broadcast round for auto-dispatch.
 * At max waves with an active search window, rebroadcast re-runs the last wave (no round burn).
 */
export function resolveDispatchBroadcastRound(params: {
  storedRound: number;
  maxRounds: number;
  forceRebroadcast: boolean;
  searchWindowActive: boolean;
}): number {
  const { storedRound, maxRounds, forceRebroadcast, searchWindowActive } = params;
  if (!forceRebroadcast) {
    return storedRound + 1;
  }
  if (storedRound >= maxRounds && searchWindowActive) {
    return maxRounds;
  }
  return Math.min(storedRound + 1, maxRounds);
}

export const WAVE3_NO_ELIGIBLE_LOG_TOKEN = "wave3_no_eligible_waiting_search_window" as const;
