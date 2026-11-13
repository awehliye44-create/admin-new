/**
 * Scheduled pickup waiting fairness SSOT.
 *
 * Eligible pickup waiting must not accumulate before
 * max(authoritative arrived_at, original scheduled_at).
 * Intermediate-stop waiting is unaffected.
 */

export function parseIsoMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Lower bound for pickup eligible waiting / free-wait / no-show clocks.
 * Returns null when neither timestamp is usable (caller keeps legacy behaviour).
 */
export function resolveScheduledPickupEligibleFromMs(input: {
  arrivedAtIso?: string | null;
  scheduledAtIso?: string | null;
  /** When false / missing scheduled_at, no floor is applied. */
  isScheduledOrigin?: boolean | null;
}): number | null {
  const arrivedMs = parseIsoMs(input.arrivedAtIso);
  const scheduledMs = parseIsoMs(input.scheduledAtIso);
  const scheduledOrigin =
    input.isScheduledOrigin === true ||
    (input.isScheduledOrigin == null && scheduledMs != null);
  if (!scheduledOrigin || scheduledMs == null) {
    return arrivedMs;
  }
  if (arrivedMs == null) return scheduledMs;
  return Math.max(arrivedMs, scheduledMs);
}

/** True while now is strictly before the eligible pickup waiting floor. */
export function isBeforeScheduledPickupEligibleWindow(input: {
  nowMs: number;
  arrivedAtIso?: string | null;
  scheduledAtIso?: string | null;
  isScheduledOrigin?: boolean | null;
}): boolean {
  const fromMs = resolveScheduledPickupEligibleFromMs(input);
  if (fromMs == null || !Number.isFinite(input.nowMs)) return false;
  return input.nowMs < fromMs;
}

/**
 * Clamp a segment interval into the eligible window.
 * Pre-scheduled time is never counted retrospectively.
 */
export function clampWaitingIntervalToEligibleWindow(input: {
  startMs: number;
  endMs: number;
  eligibleFromMs: number | null | undefined;
}): { startMs: number; endMs: number; durationMs: number } {
  let start = input.startMs;
  let end = input.endMs;
  if (
    input.eligibleFromMs != null &&
    Number.isFinite(input.eligibleFromMs)
  ) {
    if (end <= input.eligibleFromMs) {
      return { startMs: start, endMs: end, durationMs: 0 };
    }
    start = Math.max(start, input.eligibleFromMs);
  }
  const durationMs = end > start ? end - start : 0;
  return { startMs: start, endMs: end, durationMs };
}

/** Resolve pickup eligible floor from a trip row (preserves scheduled_at after rematch). */
export function eligibleFromMsForPickupTrip(trip: {
  arrived_at?: string | null;
  pickup_arrived_at?: string | null;
  scheduled_at?: string | null;
  is_scheduled?: boolean | null;
}): number | null {
  return resolveScheduledPickupEligibleFromMs({
    arrivedAtIso: trip.pickup_arrived_at ?? trip.arrived_at ?? null,
    scheduledAtIso: trip.scheduled_at ?? null,
    isScheduledOrigin: trip.is_scheduled === true ||
      Boolean(String(trip.scheduled_at ?? "").trim()),
  });
}
