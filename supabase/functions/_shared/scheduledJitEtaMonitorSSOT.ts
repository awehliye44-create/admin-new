/**
 * Phase 4 — ETA monitor for confirmed-driver JIT deadlines.
 *
 * Reuses existing routeCache (Google Directions, driver_to_pickup TTL 90s).
 * Haversine fallback via estimateEtaMinutes when routing fails.
 * Stale / missing location → unresolved (caller uses fixed Local/Long fallback).
 */

import { getRouteWithCache } from "./routeCache.ts";
import { estimateEtaMinutes } from "./scheduledDispatchConfig.ts";

export type JitLocationFreshness = {
  fresh: boolean;
  reason:
    | "ok"
    | "missing_coords"
    | "stale_heartbeat"
    | "missing_presence"
    | "presence_max_age_missing";
  lat: number | null;
  lng: number | null;
  ageSeconds: number | null;
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
  /** Epoch ms of last heartbeat or GPS sample. */
  lastSeenMs: number | null | undefined;
  nowMs: number;
  presenceMaxAgeSeconds: number | null | undefined;
}): JitLocationFreshness {
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return {
      fresh: false,
      reason: "missing_coords",
      lat: null,
      lng: null,
      ageSeconds: null,
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
    };
  }

  const lastSeen = Number(input.lastSeenMs);
  if (!Number.isFinite(lastSeen)) {
    return {
      fresh: false,
      reason: "missing_presence",
      lat,
      lng,
      ageSeconds: null,
    };
  }

  const ageSeconds = Math.max(0, (input.nowMs - lastSeen) / 1000);
  if (ageSeconds > maxAge) {
    return {
      fresh: false,
      reason: "stale_heartbeat",
      lat,
      lng,
      ageSeconds,
    };
  }

  return { fresh: true, reason: "ok", lat, lng, ageSeconds };
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

export function buildJitEtaUnresolvedOpsAlert(input: {
  tripId: string;
  driverId: string;
  reason: string;
  nowIso: string;
}): {
  fingerprint: string;
  title: string;
  related_trip_id: string;
  metadata: Record<string, unknown>;
} {
  return {
    fingerprint: `scheduled_jit_eta_unresolved:${input.tripId}`,
    title: "Scheduled JIT ETA unresolved — using fixed activation fallback",
    related_trip_id: input.tripId,
    metadata: {
      trip_id: input.tripId,
      driver_id: input.driverId,
      reason: input.reason,
      observed_at: input.nowIso,
      phase: 4,
    },
  };
}
