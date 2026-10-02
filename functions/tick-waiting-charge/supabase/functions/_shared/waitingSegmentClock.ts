/**
 * Waiting-time geofence segment clock.
 *
 * Workflow buttons stay flexible. Money counts only while trusted driver GPS
 * is inside the relevant pickup/stop radius. Request-body coords cannot
 * override a trusted outside fix.
 */

import { computePickupWaitingChargePence } from "./waitingAdminConfig.ts";

export const DEFAULT_WAITING_RADIUS_METERS = 100;
/** Presence / live fix older than this is not trusted for charging. */
export const TRUSTED_LOCATION_MAX_AGE_MS = 45_000;

export type WaitingLocationType = "pickup" | "stop";
export type WaitingGeofenceStatus = "counting" | "paused" | "not_started";

export type TrustedDriverLocation = {
  lat: number;
  lng: number;
  sampledAtIso: string;
  source: "driver_presence" | "driver_live_locations" | "drivers_current";
  ageMs: number;
};

export type GeofenceTarget = {
  lat: number;
  lng: number;
  radiusMeters: number;
  radiusEnabled: boolean;
};

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function resolveEffectiveWaitingRadiusMeters(
  configuredMeters: number | null | undefined,
  enabled: boolean,
): number {
  if (!enabled) return 0;
  const n =
    typeof configuredMeters === "number" && Number.isFinite(configuredMeters)
      ? Math.floor(configuredMeters)
      : 0;
  return n > 0 ? n : DEFAULT_WAITING_RADIUS_METERS;
}

function isFreshIso(iso: string | null | undefined, nowMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= TRUSTED_LOCATION_MAX_AGE_MS && nowMs - t >= -5_000;
}

function pickFreshPoint(
  lat: unknown,
  lng: unknown,
  atIso: string | null | undefined,
  source: TrustedDriverLocation["source"],
  nowMs: number,
): TrustedDriverLocation | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (!isFreshIso(atIso, nowMs)) return null;
  const sampledAtIso = atIso!;
  return {
    lat,
    lng,
    sampledAtIso,
    source,
    ageMs: Math.max(0, nowMs - Date.parse(sampledAtIso)),
  };
}

/**
 * Prefer presence → live_locations → drivers.current_*.
 * Body GPS is never preferred when a trusted fix exists.
 */
// deno-lint-ignore no-explicit-any
export async function resolveTrustedDriverLocation(
  supabase: any,
  driverId: string,
  nowMs = Date.now(),
): Promise<TrustedDriverLocation | null> {
  if (!driverId) return null;

  const { data: presence } = await supabase
    .from("driver_presence")
    .select(
      "lat, lng, last_gps_sample_at, last_location_at, last_heartbeat_at, updated_at",
    )
    .eq("driver_id", driverId)
    .maybeSingle();

  const presenceAt =
    (presence?.last_gps_sample_at as string | null) ??
    (presence?.last_location_at as string | null) ??
    (presence?.last_heartbeat_at as string | null) ??
    (presence?.updated_at as string | null);
  const fromPresence = pickFreshPoint(
    presence?.lat,
    presence?.lng,
    presenceAt,
    "driver_presence",
    nowMs,
  );
  if (fromPresence) return fromPresence;

  const { data: live } = await supabase
    .from("driver_live_locations")
    .select("lat, lng, updated_at")
    .eq("driver_id", driverId)
    .maybeSingle();
  const fromLive = pickFreshPoint(
    live?.lat,
    live?.lng,
    live?.updated_at as string | null,
    "driver_live_locations",
    nowMs,
  );
  if (fromLive) return fromLive;

  const { data: driver } = await supabase
    .from("drivers")
    .select("current_lat, current_lng, last_location_updated_at, last_seen_at")
    .eq("id", driverId)
    .maybeSingle();
  const driverAt =
    (driver?.last_location_updated_at as string | null) ??
    (driver?.last_seen_at as string | null);
  return pickFreshPoint(
    driver?.current_lat,
    driver?.current_lng,
    driverAt,
    "drivers_current",
    nowMs,
  );
}

/**
 * Decide inside/outside using trusted GPS.
 * If trusted says outside, body coords claiming inside are ignored.
 * If no trusted fix: fail closed (outside) — cannot invent chargeable time.
 */
export function evaluateWaitingInsideRadius(input: {
  trusted: TrustedDriverLocation | null;
  bodyLat?: number | null;
  bodyLng?: number | null;
  target: GeofenceTarget;
}): {
  inside: boolean;
  distanceMeters: number | null;
  usedSource: string;
  trustedOverridesBody: boolean;
} {
  const { trusted, target } = input;
  if (!target.radiusEnabled) {
    return {
      inside: true,
      distanceMeters: null,
      usedSource: "radius_disabled",
      trustedOverridesBody: false,
    };
  }
  const radius = resolveEffectiveWaitingRadiusMeters(
    target.radiusMeters,
    true,
  );

  if (trusted) {
    const distance = haversineMeters(
      trusted.lat,
      trusted.lng,
      target.lat,
      target.lng,
    );
    const inside = distance <= radius;
    const bodyClaimsInside =
      typeof input.bodyLat === "number" &&
      typeof input.bodyLng === "number" &&
      haversineMeters(input.bodyLat, input.bodyLng, target.lat, target.lng) <=
        radius;
    return {
      inside,
      distanceMeters: distance,
      usedSource: trusted.source,
      trustedOverridesBody: !inside && bodyClaimsInside,
    };
  }

  // No trusted fix — fail closed for money clock.
  return {
    inside: false,
    distanceMeters: null,
    usedSource: "no_trusted_location",
    trustedOverridesBody: false,
  };
}

export function segmentDurationSeconds(
  startedAtIso: string,
  endedAtIso: string | null,
  nowMs: number,
): number {
  const start = Date.parse(startedAtIso);
  if (!Number.isFinite(start)) return 0;
  const end = endedAtIso ? Date.parse(endedAtIso) : nowMs;
  if (!Number.isFinite(end) || end < start) return 0;
  return Math.max(0, Math.floor((end - start) / 1000));
}

export type WaitingSegmentRow = { started_at: string; ended_at: string | null };

/**
 * Canonical counted waiting at an explicit evaluation instant.
 * Segment ends are capped at atMs and segments starting at/after atMs are
 * excluded, so time after a terminal decision never counts. Milliseconds are
 * summed before flooring so a pause/re-open never drops a partial second.
 */
export function sumSegmentSecondsAt(
  rows: WaitingSegmentRow[],
  atMs: number,
): number {
  if (!Number.isFinite(atMs)) return 0;
  let totalMs = 0;
  for (const row of rows) {
    const start = Date.parse(row.started_at);
    if (!Number.isFinite(start) || start >= atMs) continue;
    const endRaw = row.ended_at ? Date.parse(row.ended_at) : atMs;
    if (!Number.isFinite(endRaw)) continue;
    const end = Math.min(endRaw, atMs);
    if (end > start) totalMs += end - start;
  }
  return Math.floor(totalMs / 1000);
}

export function sumSegmentSeconds(
  rows: WaitingSegmentRow[],
  nowMs: number,
): number {
  return sumSegmentSecondsAt(rows, nowMs);
}

export const WAITING_EVIDENCE_UNAVAILABLE = "WAITING_EVIDENCE_UNAVAILABLE";

export type CanonicalWaitingResolution =
  | {
    ok: true;
    countedSeconds: number;
    segmentCount: number;
    openSegmentCount: number;
    evaluatedAtIso: string;
    source: "trip_waiting_segments";
  }
  | {
    ok: false;
    reason: "invalid_evaluation_time" | "segment_query_failed";
    message: string;
    evaluatedAtIso: string | null;
  };

export class WaitingEvidenceUnavailableError extends Error {
  readonly code = WAITING_EVIDENCE_UNAVAILABLE;
  readonly resolution: Extract<CanonicalWaitingResolution, { ok: false }>;
  constructor(resolution: Extract<CanonicalWaitingResolution, { ok: false }>) {
    super(`${WAITING_EVIDENCE_UNAVAILABLE}:${resolution.reason}:${resolution.message}`);
    this.resolution = resolution;
  }
}

/**
 * Single backend source of truth for counted waiting. Reads trip_waiting_segments
 * and evaluates them at atIso (terminal decision time for Customer cancel /
 * No-Show). trips.*_waiting_counted_seconds is a display cache and must never
 * decide money. A failed read is { ok: false } — never 0.
 */
// deno-lint-ignore no-explicit-any
export async function resolveCanonicalWaitingSeconds(
  supabase: any,
  input: {
    tripId: string;
    locationType: WaitingLocationType;
    stopId?: string | null;
    atIso: string;
  },
): Promise<CanonicalWaitingResolution> {
  const atMs = Date.parse(input.atIso);
  if (!input.tripId || !Number.isFinite(atMs)) {
    return {
      ok: false,
      reason: "invalid_evaluation_time",
      message: `trip_id=${input.tripId ?? ""} at=${input.atIso ?? ""}`,
      evaluatedAtIso: null,
    };
  }
  const evaluatedAtIso = new Date(atMs).toISOString();
  let q = supabase
    .from("trip_waiting_segments")
    .select("started_at, ended_at")
    .eq("trip_id", input.tripId)
    .eq("location_type", input.locationType);
  if (input.locationType === "stop" && input.stopId) {
    q = q.eq("stop_id", input.stopId);
  }
  let data: unknown;
  let error: { message?: string } | null = null;
  try {
    const res = await q;
    data = res?.data;
    error = res?.error ?? null;
  } catch (err) {
    error = { message: err instanceof Error ? err.message : String(err) };
  }
  if (error || !Array.isArray(data)) {
    return {
      ok: false,
      reason: "segment_query_failed",
      message: error?.message ?? "segment_rows_unavailable",
      evaluatedAtIso,
    };
  }
  const rows = data as WaitingSegmentRow[];
  return {
    ok: true,
    countedSeconds: sumSegmentSecondsAt(rows, atMs),
    segmentCount: rows.length,
    openSegmentCount: rows.filter((r) => !r.ended_at).length,
    evaluatedAtIso,
    source: "trip_waiting_segments",
  };
}

export function chargeableSecondsFromCounted(
  countedSeconds: number,
  freeWaitSeconds: number,
): number {
  return Math.max(0, Math.floor(countedSeconds) - Math.max(0, Math.floor(freeWaitSeconds)));
}

export function computePickupChargeFromCountedSeconds(input: {
  countedSeconds: number;
  freeWaitSeconds: number;
  ratePencePerMinute: number;
  intervalSeconds: number;
  maxMinutes: number;
}) {
  const paidSeconds = chargeableSecondsFromCounted(
    input.countedSeconds,
    input.freeWaitSeconds,
  );
  return computePickupWaitingChargePence({
    paidSeconds,
    ratePencePerMinute: input.ratePencePerMinute,
    intervalSeconds: input.intervalSeconds,
    maxMinutes: input.maxMinutes,
  });
}

/** Continuous prorate for stop waiting from counted paid seconds. */
export function computeStopChargeFromCountedSeconds(input: {
  countedSeconds: number;
  freeWaitSeconds: number;
  ratePencePerMinute: number;
  maxMinutes: number | null;
}): { charge_pence: number; paid_seconds: number } {
  let paid = chargeableSecondsFromCounted(
    input.countedSeconds,
    input.freeWaitSeconds,
  );
  if (input.maxMinutes != null && input.maxMinutes > 0) {
    paid = Math.min(paid, Math.round(input.maxMinutes) * 60);
  }
  const rate = Math.max(0, Math.round(input.ratePencePerMinute));
  if (paid <= 0 || rate <= 0) return { charge_pence: 0, paid_seconds: paid };
  const charge = Math.round((paid / 60) * rate);
  return { charge_pence: charge, paid_seconds: paid };
}

export function noShowEligibleFromCountedSeconds(input: {
  countedSeconds: number;
  requiredWaitMinutes: number;
}): boolean {
  const need = Math.max(0, input.requiredWaitMinutes) * 60;
  if (need <= 0) return input.countedSeconds > 0;
  return input.countedSeconds >= need;
}

/**
 * Open/close in-radius segments for one waiting location and refresh trip rollups.
 */
// deno-lint-ignore no-explicit-any
export async function syncWaitingGeofenceClock(
  supabase: any,
  input: {
    tripId: string;
    driverId: string;
    locationType: WaitingLocationType;
    stopId?: string | null;
    stopIndex?: number | null;
    target: GeofenceTarget;
    bodyLat?: number | null;
    bodyLng?: number | null;
    nowIso?: string;
  },
): Promise<{
  status: WaitingGeofenceStatus;
  /**
   * Canonical segment sum at nowIso when evidenceComplete; otherwise the
   * unchanged cached counter. Money must not be decided when !evidenceComplete.
   */
  countedSeconds: number;
  evidenceComplete: boolean;
  distanceMeters: number | null;
  inside: boolean;
  usedSource: string;
  trustedOverridesBody: boolean;
}> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const trusted = await resolveTrustedDriverLocation(
    supabase,
    input.driverId,
    nowMs,
  );
  const verdict = evaluateWaitingInsideRadius({
    trusted,
    bodyLat: input.bodyLat,
    bodyLng: input.bodyLng,
    target: input.target,
  });

  let openQuery = supabase
    .from("trip_waiting_segments")
    .select("id, started_at, ended_at, stop_id")
    .eq("trip_id", input.tripId)
    .eq("location_type", input.locationType)
    .is("ended_at", null)
    .order("started_at", { ascending: false })
    .limit(1);
  if (input.locationType === "stop" && input.stopId) {
    openQuery = openQuery.eq("stop_id", input.stopId);
  }
  const { data: openRows } = await openQuery;
  const open = Array.isArray(openRows) ? openRows[0] ?? null : openRows;

  if (verdict.inside) {
    if (!open) {
      await supabase.from("trip_waiting_segments").insert({
        trip_id: input.tripId,
        location_type: input.locationType,
        stop_id: input.stopId ?? null,
        stop_index: input.stopIndex ?? null,
        started_at: nowIso,
        ended_at: null,
        inside_radius: true,
        distance_meters: verdict.distanceMeters,
        source_location: verdict.usedSource,
      });
    }
  } else if (open?.id) {
    await supabase
      .from("trip_waiting_segments")
      .update({
        ended_at: nowIso,
        distance_meters: verdict.distanceMeters,
        source_location: verdict.usedSource,
      })
      .eq("id", open.id);
  }

  // Always the full segment sum: a re-open after a pause must never reset the
  // counted total to the new segment's duration (MK-261002-004).
  const canonical = await resolveCanonicalWaitingSeconds(supabase, {
    tripId: input.tripId,
    locationType: input.locationType,
    stopId: input.stopId ?? null,
    atIso: nowIso,
  });
  const counterColumn = input.locationType === "pickup"
    ? "pickup_waiting_counted_seconds"
    : "stop_waiting_counted_seconds";
  let countedSeconds: number;
  if (canonical.ok) {
    countedSeconds = canonical.countedSeconds;
  } else {
    console.error("[waitingSegmentClock] WAITING_EVIDENCE_UNAVAILABLE", {
      trip_id: input.tripId,
      location_type: input.locationType,
      stop_id: input.stopId ?? null,
      reason: canonical.reason,
      message: canonical.message,
    });
    const { data: cached } = await supabase
      .from("trips")
      .select(counterColumn)
      .eq("id", input.tripId)
      .maybeSingle();
    const cachedNum = Number((cached as Record<string, unknown> | null)?.[counterColumn]);
    countedSeconds = Number.isFinite(cachedNum) && cachedNum > 0 ? Math.floor(cachedNum) : 0;
  }

  const status: WaitingGeofenceStatus = verdict.inside ? "counting" : "paused";
  const tripPatch: Record<string, unknown> = {
    waiting_geofence_status: status,
    waiting_geofence_checked_at: nowIso,
    waiting_geofence_distance_m: verdict.distanceMeters,
    updated_at: nowIso,
  };
  if (canonical.ok) {
    tripPatch[counterColumn] = countedSeconds;
  }
  await supabase.from("trips").update(tripPatch).eq("id", input.tripId);

  return {
    status,
    countedSeconds,
    evidenceComplete: canonical.ok,
    distanceMeters: verdict.distanceMeters,
    inside: verdict.inside,
    usedSource: verdict.usedSource,
    trustedOverridesBody: verdict.trustedOverridesBody,
  };
}

/** Close any open segments for a location (Start Trip / Drive Next / Complete). */
// deno-lint-ignore no-explicit-any
export async function closeOpenWaitingSegments(
  supabase: any,
  input: {
    tripId: string;
    locationType: WaitingLocationType;
    stopId?: string | null;
    nowIso?: string;
  },
): Promise<number> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  let q = supabase
    .from("trip_waiting_segments")
    .update({ ended_at: nowIso })
    .eq("trip_id", input.tripId)
    .eq("location_type", input.locationType)
    .is("ended_at", null);
  if (input.locationType === "stop" && input.stopId) {
    q = q.eq("stop_id", input.stopId);
  }
  await q;

  const canonical = await resolveCanonicalWaitingSeconds(supabase, {
    tripId: input.tripId,
    locationType: input.locationType,
    stopId: input.stopId ?? null,
    atIso: nowIso,
  });
  if (!canonical.ok) {
    // Callers freeze money from this value; an unreadable sum must not become 0.
    console.error("[waitingSegmentClock] WAITING_EVIDENCE_UNAVAILABLE on close", {
      trip_id: input.tripId,
      location_type: input.locationType,
      stop_id: input.stopId ?? null,
      reason: canonical.reason,
      message: canonical.message,
    });
    throw new WaitingEvidenceUnavailableError(canonical);
  }
  const counted = canonical.countedSeconds;

  const patch: Record<string, unknown> = {
    waiting_geofence_status: "not_started",
    waiting_geofence_checked_at: nowIso,
    updated_at: nowIso,
  };
  if (input.locationType === "pickup") {
    patch.pickup_waiting_counted_seconds = counted;
  } else {
    patch.stop_waiting_counted_seconds = counted;
  }
  await supabase.from("trips").update(patch).eq("id", input.tripId);
  return counted;
}

/**
 * Freeze waiting evidence at a terminal decision (Customer cancel / No-Show).
 * Only rows still open are touched, each with a conditional `ended_at IS NULL`
 * update, so replays are no-ops and finalized rows never change. ended_at is
 * clamped to started_at for rows opened after the decision
 * (trip_waiting_segments_time_order_chk). The cache is then set to the
 * canonical value at atIso.
 */
// deno-lint-ignore no-explicit-any
export async function finalizeWaitingSegmentsAtTerminal(
  supabase: any,
  input: {
    tripId: string;
    locationType: WaitingLocationType;
    stopId?: string | null;
    atIso: string;
  },
): Promise<
  | { ok: true; closedSegments: number; countedSeconds: number }
  | { ok: false; reason: string; message: string }
> {
  const atMs = Date.parse(input.atIso);
  if (!input.tripId || !Number.isFinite(atMs)) {
    return { ok: false, reason: "invalid_evaluation_time", message: String(input.atIso) };
  }
  let openQ = supabase
    .from("trip_waiting_segments")
    .select("id, started_at")
    .eq("trip_id", input.tripId)
    .eq("location_type", input.locationType)
    .is("ended_at", null);
  if (input.locationType === "stop" && input.stopId) {
    openQ = openQ.eq("stop_id", input.stopId);
  }
  const { data: openRows, error: openErr } = await openQ;
  if (openErr || !Array.isArray(openRows)) {
    return {
      ok: false,
      reason: "segment_query_failed",
      message: openErr?.message ?? "segment_rows_unavailable",
    };
  }

  let closedSegments = 0;
  for (const row of openRows as Array<{ id: string; started_at: string }>) {
    const startMs = Date.parse(row.started_at);
    const endedAt = new Date(
      Number.isFinite(startMs) ? Math.max(startMs, atMs) : atMs,
    ).toISOString();
    const { data: closed, error: closeErr } = await supabase
      .from("trip_waiting_segments")
      .update({ ended_at: endedAt })
      .eq("id", row.id)
      .is("ended_at", null)
      .select("id");
    if (closeErr) {
      return { ok: false, reason: "segment_close_failed", message: closeErr.message };
    }
    if (Array.isArray(closed) && closed.length > 0) closedSegments += 1;
  }

  const canonical = await resolveCanonicalWaitingSeconds(supabase, {
    tripId: input.tripId,
    locationType: input.locationType,
    stopId: input.stopId ?? null,
    atIso: input.atIso,
  });
  if (!canonical.ok) {
    return { ok: false, reason: canonical.reason, message: canonical.message };
  }
  const counterColumn = input.locationType === "pickup"
    ? "pickup_waiting_counted_seconds"
    : "stop_waiting_counted_seconds";
  await supabase
    .from("trips")
    .update({ [counterColumn]: canonical.countedSeconds })
    .eq("id", input.tripId);
  return { ok: true, closedSegments, countedSeconds: canonical.countedSeconds };
}
