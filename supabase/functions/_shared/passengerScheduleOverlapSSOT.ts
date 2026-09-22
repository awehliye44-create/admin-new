/**
 * Customer passenger schedule overlap — reuses corporate window math SSOT.
 * Distinct from driver check_schedule_overlap (EXECUTE-locked / wrong shape).
 *
 * 20-minute min-advance is NOT overlap protection — that stays in
 * validate-scheduled-booking advance checks only.
 */
import {
  CORPORATE_OVERLAP_BUFFER_MINUTES,
  findCorporateScheduleOverlap,
  isCorporateOverlapCandidateStatus,
  tripWindowMs,
  windowsOverlap,
  type CorporateOverlapTrip,
} from "./corporateScheduleOverlapSSOT.ts";

export {
  CORPORATE_OVERLAP_BUFFER_MINUTES as PASSENGER_OVERLAP_BUFFER_MINUTES,
  windowsOverlap,
  tripWindowMs,
  isCorporateOverlapCandidateStatus as isPassengerOverlapCandidateStatus,
};

export type PassengerOverlapTrip = CorporateOverlapTrip & {
  created_at?: string | null;
  is_scheduled?: boolean | null;
};

/** Expected interval for a scheduled or live trip. */
export function resolvePassengerExpectedWindowMs(
  trip: PassengerOverlapTrip,
  opts?: { nowMs?: number; bufferMinutes?: number },
): { start: number; end: number } | null {
  const bufferMinutes = opts?.bufferMinutes ?? CORPORATE_OVERLAP_BUFFER_MINUTES;
  if (trip.scheduled_at) {
    return tripWindowMs(trip, bufferMinutes);
  }
  // Live / immediate trip without scheduled_at — window from created_at (or now).
  if (!isCorporateOverlapCandidateStatus(trip.status)) return null;
  const nowMs = opts?.nowMs ?? Date.now();
  const startRaw = trip.created_at ? Date.parse(trip.created_at) : NaN;
  const start = Number.isFinite(startRaw) ? startRaw : nowMs;
  const durationMin = Math.max(1, Number(trip.estimated_duration_minutes ?? 30));
  const buf = bufferMinutes * 60_000;
  return {
    start: start - buf,
    end: start + durationMin * 60_000 + buf,
  };
}

export function findPassengerScheduleOverlap(args: {
  candidateScheduledAt: string | null;
  /** When candidate is immediate (NOW), pass null scheduled_at and set nowMs. */
  candidateIsImmediate?: boolean;
  candidateDurationMinutes: number;
  existing: PassengerOverlapTrip[];
  excludeTripId?: string | null;
  nowMs?: number;
}): { has_conflict: false } | {
  has_conflict: true;
  conflicting_trip_id: string;
  conflicting_time: string;
  code: "BOOKING_TIME_CONFLICT";
} {
  const nowMs = args.nowMs ?? Date.now();
  const candidateStartIso = args.candidateIsImmediate
    ? new Date(nowMs).toISOString()
    : args.candidateScheduledAt;
  if (!candidateStartIso) {
    return { has_conflict: false };
  }

  // Reuse corporate finder for scheduled↔scheduled (same window math).
  if (!args.candidateIsImmediate) {
    const base = findCorporateScheduleOverlap({
      candidateScheduledAt: candidateStartIso,
      candidateDurationMinutes: args.candidateDurationMinutes,
      existing: args.existing,
      excludeTripId: args.excludeTripId,
    });
    if (!base.has_conflict) return { has_conflict: false };
    return {
      ...base,
      code: "BOOKING_TIME_CONFLICT",
    };
  }

  const candidate: PassengerOverlapTrip = {
    id: "__candidate__",
    scheduled_at: null,
    created_at: candidateStartIso,
    estimated_duration_minutes: args.candidateDurationMinutes,
    status: "searching",
  };
  const candWin = resolvePassengerExpectedWindowMs(candidate, { nowMs });
  if (!candWin) return { has_conflict: false };

  for (const trip of args.existing) {
    if (args.excludeTripId && trip.id === args.excludeTripId) continue;
    const win = resolvePassengerExpectedWindowMs(trip, { nowMs });
    if (!win) continue;
    if (windowsOverlap(candWin.start, candWin.end, win.start, win.end)) {
      return {
        has_conflict: true,
        conflicting_trip_id: trip.id,
        conflicting_time: String(trip.scheduled_at ?? trip.created_at ?? ""),
        code: "BOOKING_TIME_CONFLICT",
      };
    }
  }
  return { has_conflict: false };
}
