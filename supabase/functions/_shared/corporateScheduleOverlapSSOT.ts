/**
 * Corporate organisation/passenger schedule overlap SSOT.
 * Distinct from driver-centric check_schedule_overlap(driver_id, trip_id)
 * which is EXECUTE-locked to postgres (Phase A6) and is the wrong product shape
 * for Corporate create-time checks (no driver yet).
 */
export const CORPORATE_OVERLAP_BUFFER_MINUTES = 15;

export type CorporateOverlapTrip = {
  id: string;
  scheduled_at: string | null;
  estimated_duration_minutes: number | null;
  status: string | null;
  passenger_id?: string | null;
  corporate_account_id?: string | null;
};

const TERMINAL = new Set([
  "cancelled",
  "canceled",
  "completed",
  "no_show",
  "failed",
  "discarded",
]);

export function isCorporateOverlapCandidateStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return !TERMINAL.has(String(status).toLowerCase());
}

/** Half-open style with buffer: [start - buf, end + buf) overlaps. */
export function windowsOverlap(
  aStartMs: number,
  aEndMs: number,
  bStartMs: number,
  bEndMs: number,
): boolean {
  return aStartMs < bEndMs && bStartMs < aEndMs;
}

export function tripWindowMs(
  trip: Pick<CorporateOverlapTrip, "scheduled_at" | "estimated_duration_minutes">,
  bufferMinutes = CORPORATE_OVERLAP_BUFFER_MINUTES,
): { start: number; end: number } | null {
  if (!trip.scheduled_at) return null;
  const start = Date.parse(trip.scheduled_at);
  if (!Number.isFinite(start)) return null;
  const durationMin = Math.max(1, Number(trip.estimated_duration_minutes ?? 30));
  const buf = bufferMinutes * 60_000;
  return {
    start: start - buf,
    end: start + durationMin * 60_000 + buf,
  };
}

export function findCorporateScheduleOverlap(args: {
  candidateScheduledAt: string;
  candidateDurationMinutes: number;
  existing: CorporateOverlapTrip[];
  /** Exclude this trip id (retries / same booking). */
  excludeTripId?: string | null;
}): { has_conflict: false } | {
  has_conflict: true;
  conflicting_trip_id: string;
  conflicting_time: string;
} {
  const candidate: CorporateOverlapTrip = {
    id: "__candidate__",
    scheduled_at: args.candidateScheduledAt,
    estimated_duration_minutes: args.candidateDurationMinutes,
    status: "scheduled",
  };
  const candWin = tripWindowMs(candidate);
  if (!candWin) {
    return { has_conflict: false };
  }

  for (const trip of args.existing) {
    if (args.excludeTripId && trip.id === args.excludeTripId) continue;
    if (!isCorporateOverlapCandidateStatus(trip.status)) continue;
    const win = tripWindowMs(trip);
    if (!win) continue;
    if (windowsOverlap(candWin.start, candWin.end, win.start, win.end)) {
      return {
        has_conflict: true,
        conflicting_trip_id: trip.id,
        conflicting_time: String(trip.scheduled_at),
      };
    }
  }
  return { has_conflict: false };
}
