/**
 * Trip schedule overlap SSOT (Driver + Customer).
 *
 * Canonical conflict decisions live in Postgres:
 *   public.evaluate_trip_schedule_conflict(...)
 *   public.resolve_scheduled_overlap_buffer_minutes(service_area_id)
 *
 * This module mirrors the interval mathematics for Deno/Edge callers and lock
 * tests. Apps must NEVER invent a parallel buffer/constant or run their own
 * authoritative conflict math — call the RPC (or this shared helper when the
 * Edge layer already holds the same trip rows the RPC would load).
 *
 * OVERLAP BUFFER ≠ scheduled_broadcast_at / scheduled_convert_at.
 */

export const DEFAULT_SCHEDULED_OVERLAP_BUFFER_MINUTES = 30;
export const SCHEDULED_TRIP_OVERLAP_ERROR = "SCHEDULED_TRIP_OVERLAP" as const;

export const DRIVER_SCHEDULED_OVERLAP_MESSAGE =
  "You already have a booking that conflicts with this time.";

export const CUSTOMER_SCHEDULED_OVERLAP_MESSAGE =
  "You already have a booking that conflicts with this time. Please choose another time.";

const TERMINAL_STATUSES = new Set([
  "completed",
  "cancelled",
  "canceled",
  "expired",
  "expired_no_driver",
  "no_show",
  "failed",
  "discarded",
]);

export type OverlapSubjectKind = "driver" | "customer";
export type OverlapCandidateMode = "scheduled" | "immediate";

export type OverlapTripRow = {
  id: string;
  scheduled_at: string | null;
  estimated_duration_minutes: number | null;
  status: string | null;
  started_at?: string | null;
  accepted_at?: string | null;
  arrived_at?: string | null;
  created_at?: string | null;
  dispatch_mode?: string | null;
  service_area_id?: string | null;
  confirmed_driver_id?: string | null;
  driver_id?: string | null;
  passenger_id?: string | null;
};

export type OverlapEvaluation = {
  conflict: boolean;
  reason: string | null;
  conflicting_trip_id: string | null;
  protected_start: string | null;
  protected_end: string | null;
  buffer_minutes: number;
  candidate_start: string | null;
  candidate_end: string | null;
};

/** Resolve SA buffer with safe canonical fallback (matches SQL helper). */
export function resolveScheduledOverlapBufferMinutes(
  raw: number | null | undefined,
): number {
  if (raw == null || !Number.isFinite(Number(raw))) {
    return DEFAULT_SCHEDULED_OVERLAP_BUFFER_MINUTES;
  }
  const n = Math.trunc(Number(raw));
  if (n < 0 || n > 240) return DEFAULT_SCHEDULED_OVERLAP_BUFFER_MINUTES;
  return n;
}

export function isOverlapBlockingStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return !TERMINAL_STATUSES.has(String(status).toLowerCase());
}

export function estimatedTripDurationMinutes(
  estimatedDurationMinutes: number | null | undefined,
): number {
  const n = Number(estimatedDurationMinutes);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.max(1, Math.trunc(n));
}

/** Exact boundary allowed: aEnd == bStart is NOT a conflict. */
export function intervalsOverlapHalfOpen(
  aStartMs: number,
  aEndMs: number,
  bStartMs: number,
  bEndMs: number,
): boolean {
  return aStartMs < bEndMs && aEndMs > bStartMs;
}

export function scheduledProtectedWindowMs(args: {
  scheduledAtIso: string;
  estimatedDurationMinutes: number | null | undefined;
  bufferMinutes: number;
}): { startMs: number; endMs: number; rawEndMs: number } | null {
  const startMs = Date.parse(args.scheduledAtIso);
  if (!Number.isFinite(startMs)) return null;
  const durationMin = estimatedTripDurationMinutes(args.estimatedDurationMinutes);
  const rawEndMs = startMs + durationMin * 60_000;
  const buf = Math.max(0, args.bufferMinutes) * 60_000;
  return {
    startMs: startMs - buf,
    endMs: rawEndMs + buf,
    rawEndMs,
  };
}

/** Immediate/NOW candidate: no extra buffer on the candidate interval. */
export function immediateRequiredWindowMs(args: {
  startIso: string;
  estimatedDurationMinutes: number | null | undefined;
}): { startMs: number; endMs: number } | null {
  const startMs = Date.parse(args.startIso);
  if (!Number.isFinite(startMs)) return null;
  const durationMin = estimatedTripDurationMinutes(args.estimatedDurationMinutes);
  return { startMs, endMs: startMs + durationMin * 60_000 };
}

function existingTripAnchorIso(trip: OverlapTripRow): string | null {
  if (trip.scheduled_at) return trip.scheduled_at;
  return (
    trip.started_at ||
    trip.arrived_at ||
    trip.created_at ||
    null
  );
}

/**
 * Evaluate candidate vs existing rows using the same math as the SQL RPC.
 * existing rows must already be scoped to the subject (driver/customer).
 */
export function evaluateTripScheduleOverlap(args: {
  candidateMode: OverlapCandidateMode;
  candidateStartIso: string;
  candidateEstimatedEndIso?: string | null;
  candidateDurationMinutes?: number | null;
  bufferMinutes: number;
  existing: OverlapTripRow[];
  excludeTripId?: string | null;
}): OverlapEvaluation {
  const bufferMinutes = resolveScheduledOverlapBufferMinutes(args.bufferMinutes);
  const empty: OverlapEvaluation = {
    conflict: false,
    reason: null,
    conflicting_trip_id: null,
    protected_start: null,
    protected_end: null,
    buffer_minutes: bufferMinutes,
    candidate_start: null,
    candidate_end: null,
  };

  let candStartMs: number;
  let candEndMs: number;

  if (args.candidateMode === "scheduled") {
    const win = scheduledProtectedWindowMs({
      scheduledAtIso: args.candidateStartIso,
      estimatedDurationMinutes: args.candidateDurationMinutes,
      bufferMinutes,
    });
    if (!win) return empty;
    candStartMs = win.startMs;
    candEndMs = win.endMs;
  } else if (args.candidateEstimatedEndIso) {
    const startMs = Date.parse(args.candidateStartIso);
    const endMs = Date.parse(args.candidateEstimatedEndIso);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return empty;
    candStartMs = startMs;
    candEndMs = endMs;
  } else {
    const win = immediateRequiredWindowMs({
      startIso: args.candidateStartIso,
      estimatedDurationMinutes: args.candidateDurationMinutes,
    });
    if (!win) return empty;
    candStartMs = win.startMs;
    candEndMs = win.endMs;
  }

  for (const trip of args.existing) {
    if (args.excludeTripId && trip.id === args.excludeTripId) continue;
    if (!isOverlapBlockingStatus(trip.status)) continue;

    const anchor = existingTripAnchorIso(trip);
    if (!anchor) continue;

    // Upcoming / confirmed scheduled commitments always use the protected window.
    // Live NOW trips (no scheduled_at) use the raw required interval.
    const existingWin = trip.scheduled_at
      ? scheduledProtectedWindowMs({
        scheduledAtIso: trip.scheduled_at,
        estimatedDurationMinutes: trip.estimated_duration_minutes,
        bufferMinutes,
      })
      : (() => {
        const raw = immediateRequiredWindowMs({
          startIso: anchor,
          estimatedDurationMinutes: trip.estimated_duration_minutes,
        });
        return raw ? { startMs: raw.startMs, endMs: raw.endMs, rawEndMs: raw.endMs } : null;
      })();
    if (!existingWin) continue;

    if (
      intervalsOverlapHalfOpen(
        candStartMs,
        candEndMs,
        existingWin.startMs,
        existingWin.endMs,
      )
    ) {
      return {
        conflict: true,
        reason: SCHEDULED_TRIP_OVERLAP_ERROR,
        conflicting_trip_id: trip.id,
        protected_start: new Date(existingWin.startMs).toISOString(),
        protected_end: new Date(existingWin.endMs).toISOString(),
        buffer_minutes: bufferMinutes,
        candidate_start: new Date(candStartMs).toISOString(),
        candidate_end: new Date(candEndMs).toISOString(),
      };
    }
  }

  return {
    ...empty,
    candidate_start: new Date(candStartMs).toISOString(),
    candidate_end: new Date(candEndMs).toISOString(),
  };
}

export function parseOverlapRpcResult(raw: unknown): OverlapEvaluation {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const conflict = row.conflict === true || row.has_conflict === true;
  return {
    conflict,
    reason: typeof row.reason === "string"
      ? row.reason
      : (conflict ? SCHEDULED_TRIP_OVERLAP_ERROR : null),
    conflicting_trip_id: typeof row.conflicting_trip_id === "string"
      ? row.conflicting_trip_id
      : null,
    protected_start: typeof row.protected_start === "string" ? row.protected_start : null,
    protected_end: typeof row.protected_end === "string" ? row.protected_end : null,
    buffer_minutes: resolveScheduledOverlapBufferMinutes(
      typeof row.buffer_minutes === "number" ? row.buffer_minutes : undefined,
    ),
    candidate_start: typeof row.candidate_start === "string" ? row.candidate_start : null,
    candidate_end: typeof row.candidate_end === "string" ? row.candidate_end : null,
  };
}
