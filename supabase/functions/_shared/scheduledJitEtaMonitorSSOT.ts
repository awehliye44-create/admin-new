/**
 * Phase 4/5 — ETA monitor for confirmed-driver JIT deadlines.
 *
 * Reuses existing routeCache (Google Directions, driver_to_pickup TTL 90s).
 * Haversine fallback via estimateEtaMinutes when routing fails with fresh GPS.
 *
 * Freshness is GPS-measurement based (last_gps_sample_at), never heartbeat alone.
 * Stale GPS does not become "fresh" by rewriting timestamps.
 * Callers use pickup-aware fallback hierarchy (sticky / recent route /
 * last-known conservative / degraded unknown) — never silent fixed T−11/T−30.
 */

import { getRecentDriverToPickupRoute, getRouteWithCache } from "./routeCache.ts";
import { estimateEtaMinutes } from "./scheduledDispatchConfig.ts";
import {
  applyLastKnownUncertaintyMinutes,
  SCHEDULED_JIT_FALLBACK_DEFAULTS,
} from "./scheduledJitPickupAwareFallbackSSOT.ts";

export type JitLocationFreshness = {
  fresh: boolean;
  reason:
    | "ok"
    | "missing_coords"
    | "stale_heartbeat"
    | "stale_gps"
    | "missing_presence"
    | "presence_max_age_missing";
  lat: number | null;
  lng: number | null;
  ageSeconds: number | null;
  /** GPS measurement age (last_gps_sample_at). Null when unknown. */
  gpsAgeSeconds: number | null;
  /** Heartbeat age — informational only; never makes GPS fresh. */
  heartbeatAgeSeconds: number | null;
  /** Coords exist and GPS measurement within last-known max age. */
  usableLastKnown: boolean;
};

export type JitEtaResolution =
  | {
    ok: true;
    etaMinutes: number;
    source: "route_cache" | "haversine_fallback";
    lat: number;
    lng: number;
  }
  | {
    ok: false;
    reason: JitLocationFreshness["reason"] | "routing_failed";
    lat: number | null;
    lng: number | null;
  };

export function evaluateJitDriverLocationFreshness(input: {
  lat: number | null | undefined;
  lng: number | null | undefined;
  /**
   * @deprecated Prefer gpsSampleAtMs. Kept for callers that only have a blended
   * last-seen; when gpsSampleAtMs is absent this is treated as GPS age only if
   * no heartbeatMs is supplied separately.
   */
  lastSeenMs?: number | null | undefined;
  /** GPS measurement time (last_gps_sample_at) — authoritative for freshness. */
  gpsSampleAtMs?: number | null | undefined;
  /** Heartbeat time — liveness only; must not make stale GPS appear fresh. */
  heartbeatAtMs?: number | null | undefined;
  nowMs: number;
  presenceMaxAgeSeconds: number | null | undefined;
  lastKnownMaxAgeSeconds?: number | null | undefined;
}): JitLocationFreshness {
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  const lastKnownMax = Math.max(
    1,
    Number(
      input.lastKnownMaxAgeSeconds ??
        SCHEDULED_JIT_FALLBACK_DEFAULTS.lastKnownMaxAgeSeconds,
    ) || SCHEDULED_JIT_FALLBACK_DEFAULTS.lastKnownMaxAgeSeconds,
  );

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return {
      fresh: false,
      reason: "missing_coords",
      lat: null,
      lng: null,
      ageSeconds: null,
      gpsAgeSeconds: null,
      heartbeatAgeSeconds: null,
      usableLastKnown: false,
    };
  }

  const maxAge = Number(input.presenceMaxAgeSeconds);
  if (!Number.isFinite(maxAge) || maxAge <= 0) {
    return {
      fresh: false,
      reason: "presence_max_age_missing",
      lat,
      lng,
      ageSeconds: null,
      gpsAgeSeconds: null,
      heartbeatAgeSeconds: null,
      usableLastKnown: false,
    };
  }

  const gpsMs = Number(input.gpsSampleAtMs);
  const hbMs = Number(input.heartbeatAtMs);
  const legacyMs = Number(input.lastSeenMs);
  const gpsMeasuredMs = Number.isFinite(gpsMs)
    ? gpsMs
    : !Number.isFinite(hbMs) && Number.isFinite(legacyMs)
    ? legacyMs
    : NaN;

  const gpsAgeSeconds = Number.isFinite(gpsMeasuredMs)
    ? Math.max(0, (input.nowMs - gpsMeasuredMs) / 1000)
    : null;
  const heartbeatAgeSeconds = Number.isFinite(hbMs)
    ? Math.max(0, (input.nowMs - hbMs) / 1000)
    : null;

  if (gpsAgeSeconds == null) {
    return {
      fresh: false,
      reason: "missing_presence",
      lat,
      lng,
      ageSeconds: heartbeatAgeSeconds,
      gpsAgeSeconds: null,
      heartbeatAgeSeconds,
      usableLastKnown: false,
    };
  }

  const usableLastKnown = gpsAgeSeconds <= lastKnownMax;
  if (gpsAgeSeconds > maxAge) {
    return {
      fresh: false,
      reason: "stale_gps",
      lat,
      lng,
      ageSeconds: gpsAgeSeconds,
      gpsAgeSeconds,
      heartbeatAgeSeconds,
      usableLastKnown,
    };
  }

  return {
    fresh: true,
    reason: "ok",
    lat,
    lng,
    ageSeconds: gpsAgeSeconds,
    gpsAgeSeconds,
    heartbeatAgeSeconds,
    usableLastKnown: true,
  };
}

/** Build tier-D last-known sample from freshness + haversine (with uncertainty). */
export function buildLastKnownConservativeSample(input: {
  freshness: JitLocationFreshness;
  pickupLat: number;
  pickupLng: number;
  gpsMeasuredAtMs: number | null | undefined;
}): {
  lat: number;
  lng: number;
  gpsMeasuredAtMs: number;
  conservativeEtaMinutes: number;
} | null {
  if (
    !input.freshness.usableLastKnown ||
    input.freshness.lat == null ||
    input.freshness.lng == null
  ) {
    return null;
  }
  const measured = Number(input.gpsMeasuredAtMs);
  if (!Number.isFinite(measured)) return null;
  const base = estimateEtaMinutes(
    input.freshness.lat,
    input.freshness.lng,
    input.pickupLat,
    input.pickupLng,
  );
  if (base == null) return null;
  return {
    lat: input.freshness.lat,
    lng: input.freshness.lng,
    gpsMeasuredAtMs: measured,
    conservativeEtaMinutes: applyLastKnownUncertaintyMinutes(base),
  };
}

export async function loadRecentDriverToPickupRouteSample(
  supabase: any,
  tripId: string,
  confirmedDriverId: string | null,
): Promise<{
  durationMin: number;
  cachedAtMs: number;
  originLat: number;
  originLng: number;
  confirmedDriverId: string | null;
} | null> {
  const row = await getRecentDriverToPickupRoute(supabase, tripId);
  if (!row) return null;
  const cachedAtMs = Date.parse(String(row.cached_at));
  if (!Number.isFinite(cachedAtMs)) return null;
  return {
    durationMin: Number(row.duration_min),
    cachedAtMs,
    originLat: Number(row.origin_lat),
    originLng: Number(row.origin_lng),
    confirmedDriverId,
  };
}

/**
 * Resolve driver→pickup ETA. Never treats stale location as current.
 * On routing failure with fresh coords, uses haversine estimate (safe fallback ETA).
 * Caller still may prefer fixed activation rules when this returns ok:false.
 */
export async function resolveJitDriverToPickupEta(input: {
  supabase: any;
  tripId: string;
  pickupLat: number;
  pickupLng: number;
  freshness: JitLocationFreshness;
  forceRefresh?: boolean;
}): Promise<JitEtaResolution> {
  if (!input.freshness.fresh || input.freshness.lat == null || input.freshness.lng == null) {
    return {
      ok: false,
      reason: input.freshness.reason,
      lat: input.freshness.lat,
      lng: input.freshness.lng,
    };
  }

  const lat = input.freshness.lat;
  const lng = input.freshness.lng;

  try {
    const route = await getRouteWithCache(
      input.supabase,
      input.tripId,
      "driver_to_pickup",
      lat,
      lng,
      input.pickupLat,
      input.pickupLng,
      "manual",
      input.forceRefresh === true,
    );
    const eta = Math.max(1, Math.ceil(Number(route.duration_min) || 0));
    return { ok: true, etaMinutes: eta, source: "route_cache", lat, lng };
  } catch (err) {
    console.warn("[scheduledJitEta] routeCache failed — haversine fallback", {
      trip_id: input.tripId,
      error: String((err as Error)?.message ?? err),
    });
    const fallback = estimateEtaMinutes(lat, lng, input.pickupLat, input.pickupLng);
    if (fallback == null) {
      return { ok: false, reason: "routing_failed", lat, lng };
    }
    return {
      ok: true,
      etaMinutes: fallback,
      source: "haversine_fallback",
      lat,
      lng,
    };
  }
}

export type JitMonitorPersistPatch = {
  scheduled_jit_activate_at: string;
  scheduled_jit_eta_minutes: number;
  scheduled_jit_eta_observed_at: string;
  scheduled_jit_distance_kind: string;
  scheduled_jit_eta_source: string;
  scheduled_jit_basis_scheduled_at: string;
  updated_at: string;
};

export function buildJitMonitorPersistPatch(input: {
  deadlineMs: number;
  etaMinutes: number;
  kind: string;
  etaSource: string;
  basisScheduledAtIso: string;
  nowIso: string;
}): JitMonitorPersistPatch {
  return {
    scheduled_jit_activate_at: new Date(input.deadlineMs).toISOString(),
    scheduled_jit_eta_minutes: input.etaMinutes,
    scheduled_jit_eta_observed_at: input.nowIso,
    scheduled_jit_distance_kind: input.kind,
    scheduled_jit_eta_source: input.etaSource,
    scheduled_jit_basis_scheduled_at: input.basisScheduledAtIso,
    updated_at: input.nowIso,
  };
}

/** Clear dynamic JIT stamps on release / reassignment / reschedule handoff. */
export function buildJitMonitorClearPatch(nowIso: string): Record<string, unknown> {
  return {
    scheduled_jit_activate_at: null,
    scheduled_jit_eta_minutes: null,
    scheduled_jit_eta_observed_at: null,
    scheduled_jit_distance_kind: null,
    scheduled_jit_eta_source: null,
    scheduled_jit_basis_scheduled_at: null,
    scheduled_jit_eta_spike_samples: 0,
    updated_at: nowIso,
  };
}

export function buildJitEtaUnresolvedOpsAlert(input: {
  tripId: string;
  driverId: string;
  reason: string;
  nowIso: string;
  tier?: string | null;
}): {
  fingerprint: string;
  title: string;
  related_trip_id: string;
  metadata: Record<string, unknown>;
} {
  return {
    fingerprint: `scheduled_jit_eta_unresolved:${input.tripId}`,
    title:
      "Scheduled JIT ETA unresolved — pickup-aware degraded/sticky fallback in use",
    related_trip_id: input.tripId,
    metadata: {
      trip_id: input.tripId,
      driver_id: input.driverId,
      reason: input.reason,
      observed_at: input.nowIso,
      fallback_tier: input.tier ?? null,
      phase: 5,
      fixed_t30_forbidden_as_silent_assume: true,
    },
  };
}
