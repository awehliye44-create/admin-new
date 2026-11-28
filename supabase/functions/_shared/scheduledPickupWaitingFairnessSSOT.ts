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

/**
 * Resolve pickup eligible floor from a trip row.
 *
 * Scheduled origin = authoritative booking classification:
 * - is_scheduled === true, OR
 * - scheduled_at still present after convert/rematch (Bug #38 rematch protection)
 *
 * Ordinary instant bookings have is_scheduled=false and scheduled_at=null — floor
 * is arrived_at only (Bug #38B). Never invent scheduled origin from pause state,
 * arrival time, or eligible_waiting_from alone. Intermediate stops do not use this.
 */
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
