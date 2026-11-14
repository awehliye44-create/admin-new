/**
 * Confirmed-driver JIT pickup-aware deadline resolution (MK-261114-002).
 *
 * Hierarchy (never silently assume fixed Local T−11 / Long T−30 can reach pickup):
 *   A. Fresh authoritative road-routing ETA
 *   B. Previously calculated sticky deadline (same driver + scheduled_at basis)
 *   C. Recent trustworthy driver_to_pickup route ETA (age + origin-drift guarded)
 *   D. Conservative estimate from last-known GPS measurement (uncertainty uplift;
 *      never labelled fresh)
 *   E. Explicit degraded unknown-ETA readiness lead + ops visibility
 *
 * Dynamic deadline always applies target early arrival + local/long preparation
 * buffer when a defensible pickup ETA exists. Long/local classification uses
 * driver→pickup ETA only — never passenger booked journey duration.
 */

import {
  classifyJitDistanceKind,
  computeJitDepartureDeadlineMs,
  reconcileStickyJitDeadline,
  resolveReusableStickyJitDeadlineMs,
  type ScheduledJitActivationConfig,
} from "./scheduledJitActivationSSOT.ts";

export type JitPickupEtaTier =
  | "route_fresh"
  | "sticky"
  | "route_recent"
  | "last_known_conservative"
  | "degraded_unknown";

export type ScheduledJitFallbackConfig = {
  /** Max age of an expired route-cache row still usable as tier C. */
  recentRouteMaxAgeSeconds: number;
  /** Max age of a GPS *measurement* usable for tier D (not heartbeat). */
  lastKnownMaxAgeSeconds: number;
  /** Multiplier applied to last-known haversine/route estimate. */
  lastKnownUncertaintyFactor: number;
  /** Extra minutes added after uncertainty factor (floor). */
  lastKnownUncertaintyFloorMinutes: number;
  /**
   * Extra lead beyond (longThreshold + early + longBuffer) when ETA is unknown.
   * Explicit degraded policy — not a silent raise of every fixed T−30.
   */
  unknownEtaSlackMinutes: number;
  /** Metres: reject recent route if origin drifted more than this. */
  recentRouteMaxOriginDriftMeters: number;
  /**
   * When GPS is not fresh and no sticky exists, start readiness escalation this
   * many minutes before the degraded unknown deadline.
   */
  locationReadinessLeadMinutes: number;
};

export const SCHEDULED_JIT_FALLBACK_DEFAULTS: ScheduledJitFallbackConfig = {
  recentRouteMaxAgeSeconds: 15 * 60,
  lastKnownMaxAgeSeconds: 45 * 60,
  lastKnownUncertaintyFactor: 1.25,
  lastKnownUncertaintyFloorMinutes: 8,
  unknownEtaSlackMinutes: 15,
  recentRouteMaxOriginDriftMeters: 400,
  locationReadinessLeadMinutes: 45,
};

export type RecentRouteEtaSample = {
  durationMin: number;
  cachedAtMs: number;
  originLat: number;
  originLng: number;
  /** Confirmed driver id that owned the trip when cached (optional). */
  confirmedDriverId?: string | null;
};

export type LastKnownLocationSample = {
  lat: number;
  lng: number;
  /** GPS measurement time — never heartbeat / DB write alone. */
  gpsMeasuredAtMs: number;
  /** Pre-computed conservative ETA minutes (already includes uncertainty). */
  conservativeEtaMinutes: number;
};

export type JitLateRiskAssessment = {
  targetArrivalMs: number;
  predictedArrivalMs: number | null;
  lateVsTargetMinutes: number | null;
  lateVsPickupMinutes: number | null;
  cannotMeetTarget: boolean;
};

export function computeDegradedUnknownEtaMinutes(
  config: ScheduledJitActivationConfig,
  fallback: ScheduledJitFallbackConfig = SCHEDULED_JIT_FALLBACK_DEFAULTS,
): number {
  // Assume at least the long-distance threshold of travel, plus explicit slack.
  return (
    Math.max(1, Math.floor(config.longDistanceEtaThresholdMinutes)) +
    Math.max(0, Math.floor(fallback.unknownEtaSlackMinutes))
  );
}

export function applyLastKnownUncertaintyMinutes(
  baseEtaMinutes: number,
  fallback: ScheduledJitFallbackConfig = SCHEDULED_JIT_FALLBACK_DEFAULTS,
): number {
  const scaled = Math.ceil(
    Math.max(1, baseEtaMinutes) * fallback.lastKnownUncertaintyFactor,
  );
  return Math.max(
    scaled,
    Math.max(1, baseEtaMinutes) + fallback.lastKnownUncertaintyFloorMinutes,
  );
}

export function evaluateJitLateRisk(input: {
  nowMs: number;
  scheduledAtMs: number;
  targetEarlyArrivalMinutes: number;
  etaMinutes: number | null | undefined;
}): JitLateRiskAssessment {
  const early = Math.max(0, Math.floor(input.targetEarlyArrivalMinutes));
  const targetArrivalMs = input.scheduledAtMs - early * 60_000;
  if (input.etaMinutes == null || !Number.isFinite(input.etaMinutes)) {
    return {
      targetArrivalMs,
      predictedArrivalMs: null,
      lateVsTargetMinutes: null,
      lateVsPickupMinutes: null,
      cannotMeetTarget: false,
    };
  }
  const eta = Math.max(1, Math.ceil(Number(input.etaMinutes)));
  const predictedArrivalMs = input.nowMs + eta * 60_000;
  const lateVsTargetMinutes = Math.ceil(
    (predictedArrivalMs - targetArrivalMs) / 60_000,
  );
  const lateVsPickupMinutes = Math.ceil(
    (predictedArrivalMs - input.scheduledAtMs) / 60_000,
  );
  return {
    targetArrivalMs,
    predictedArrivalMs,
    lateVsTargetMinutes,
    lateVsPickupMinutes,
    cannotMeetTarget: predictedArrivalMs > targetArrivalMs,
  };
}

/**
 * Resolve a pickup-aware deadline for a confirmed scheduled commitment.
 * Prefer earlier safe deadlines; never postpone a sticky because a later ETA
 * is missing or temporarily improved (caller uses reconcileSticky for pulls).
 */
export function resolvePickupAwareJitDeadline(input: {
  nowMs: number;
  scheduledAtMs: number;
  jitConfig: ScheduledJitActivationConfig;
  fallbackConfig?: ScheduledJitFallbackConfig;
  /** Tier A — fresh road ETA minutes. */
  freshRouteEtaMinutes?: number | null;
  /** Tier B inputs. */
  stickyActivateAtIso?: string | null;
  stickyBasisScheduledAtIso?: string | null;
  evaluatingConfirmedDriverId?: string | null;
  tripConfirmedDriverId?: string | null;
  /** Tier C. */
  recentRoute?: RecentRouteEtaSample | null;
  currentDriverLat?: number | null;
  currentDriverLng?: number | null;
  /** Tier D. */
  lastKnown?: LastKnownLocationSample | null;
  /**
   * Previous sticky deadline ms already accepted this tick (after reconcile).
   * When set with a new candidate, never postpone.
   */
  previousDeadlineMs?: number | null;
}): {
  deadlineMs: number;
  etaMinutes: number | null;
  kind: string;
  tier: JitPickupEtaTier;
  lateRisk: JitLateRiskAssessment;
  reason: string;
} {
  const fallback = input.fallbackConfig ?? SCHEDULED_JIT_FALLBACK_DEFAULTS;
  const cfg = input.jitConfig;

  const finish = (
    deadlineMs: number,
    etaMinutes: number | null,
    kind: string,
    tier: JitPickupEtaTier,
    reason: string,
  ) => {
    const lateRisk = evaluateJitLateRisk({
      nowMs: input.nowMs,
      scheduledAtMs: input.scheduledAtMs,
      targetEarlyArrivalMinutes: cfg.targetEarlyArrivalMinutes,
      etaMinutes,
    });
    // If already cannot meet target, do not wait for a future deadline — arm now.
    const effectiveDeadline = lateRisk.cannotMeetTarget
      ? Math.min(deadlineMs, input.nowMs)
      : deadlineMs;
    return {
      deadlineMs: effectiveDeadline,
      etaMinutes,
      kind,
      tier,
      lateRisk,
      reason: lateRisk.cannotMeetTarget ? `${reason}+late_risk_arm_now` : reason,
    };
  };

  // A — fresh route
  if (
    input.freshRouteEtaMinutes != null &&
    Number.isFinite(input.freshRouteEtaMinutes) &&
    input.freshRouteEtaMinutes > 0
  ) {
    const computed = computeJitDepartureDeadlineMs({
      scheduledAtMs: input.scheduledAtMs,
      driverToPickupEtaMinutes: input.freshRouteEtaMinutes,
      config: cfg,
    });
    const sticky = reconcileStickyJitDeadline({
      previousDeadlineMs: input.previousDeadlineMs,
      candidateDeadlineMs: computed.deadlineMs,
      oscillationToleranceMinutes: cfg.oscillationToleranceMinutes,
      currentScheduledAtMs: input.scheduledAtMs,
    });
    return finish(
      sticky.deadlineMs,
      computed.etaMinutes,
      computed.kind,
      "route_fresh",
      `route_fresh:${sticky.reason}`,
    );
  }

  // B — sticky
  const stickyReuse = resolveReusableStickyJitDeadlineMs({
    activateAtIso: input.stickyActivateAtIso,
    basisScheduledAtIso: input.stickyBasisScheduledAtIso,
    currentScheduledAtIso: new Date(input.scheduledAtMs).toISOString(),
    evaluatingConfirmedDriverId: input.evaluatingConfirmedDriverId,
    tripConfirmedDriverId: input.tripConfirmedDriverId,
  });
  if (stickyReuse.deadlineMs != null) {
    return finish(
      stickyReuse.deadlineMs,
      null,
      "jit",
      "sticky",
      stickyReuse.reason,
    );
  }

  // C — recent route
  const recent = input.recentRoute;
  if (recent && Number.isFinite(recent.durationMin) && recent.durationMin > 0) {
    const ageSec = (input.nowMs - recent.cachedAtMs) / 1000;
    const ageOk = ageSec >= 0 && ageSec <= fallback.recentRouteMaxAgeSeconds;
    const driverMatch =
      !recent.confirmedDriverId ||
      !input.evaluatingConfirmedDriverId ||
      String(recent.confirmedDriverId) === String(input.evaluatingConfirmedDriverId);
    let driftOk = true;
    if (
      input.currentDriverLat != null &&
      input.currentDriverLng != null &&
      Number.isFinite(input.currentDriverLat) &&
      Number.isFinite(input.currentDriverLng)
    ) {
      driftOk =
        haversineMeters(
          input.currentDriverLat,
          input.currentDriverLng,
          recent.originLat,
          recent.originLng,
        ) <= fallback.recentRouteMaxOriginDriftMeters;
    }
    if (ageOk && driverMatch && driftOk) {
      const computed = computeJitDepartureDeadlineMs({
        scheduledAtMs: input.scheduledAtMs,
        driverToPickupEtaMinutes: recent.durationMin,
        config: cfg,
      });
      return finish(
        computed.deadlineMs,
        computed.etaMinutes,
        computed.kind,
        "route_recent",
        "route_recent",
      );
    }
  }

  // D — last-known conservative
  const lastKnown = input.lastKnown;
  if (
    lastKnown &&
    Number.isFinite(lastKnown.conservativeEtaMinutes) &&
    lastKnown.conservativeEtaMinutes > 0
  ) {
    const ageSec = (input.nowMs - lastKnown.gpsMeasuredAtMs) / 1000;
    if (ageSec >= 0 && ageSec <= fallback.lastKnownMaxAgeSeconds) {
      const computed = computeJitDepartureDeadlineMs({
        scheduledAtMs: input.scheduledAtMs,
        driverToPickupEtaMinutes: lastKnown.conservativeEtaMinutes,
        config: cfg,
      });
      return finish(
        computed.deadlineMs,
        computed.etaMinutes,
        computed.kind,
        "last_known_conservative",
        "last_known_conservative",
      );
    }
  }

  // E — degraded unknown (explicit — not fixed T−11/T−30)
  const assumed = computeDegradedUnknownEtaMinutes(cfg, fallback);
  const computed = computeJitDepartureDeadlineMs({
    scheduledAtMs: input.scheduledAtMs,
    driverToPickupEtaMinutes: assumed,
    config: cfg,
  });
  // Force long kind visibility for ops when using unknown assumed ETA ≥ threshold.
  const classified = classifyJitDistanceKind({
    driverToPickupEtaMinutes: assumed,
    longDistanceEtaThresholdMinutes: cfg.longDistanceEtaThresholdMinutes,
  });
  return finish(
    computed.deadlineMs,
    assumed,
    classified.kind,
    "degraded_unknown",
    "degraded_unknown_eta",
  );
}

/** True when we should escalate location readiness (silent — no Heading alert). */
export function shouldEscalateScheduledLocationReadiness(input: {
  nowMs: number;
  degradedDeadlineMs: number;
  hasStickyDeadline: boolean;
  gpsFreshForRouting: boolean;
  leadMinutes?: number;
}): boolean {
  if (input.hasStickyDeadline || input.gpsFreshForRouting) return false;
  const lead =
    Math.max(
      1,
      Math.floor(
        input.leadMinutes ??
          SCHEDULED_JIT_FALLBACK_DEFAULTS.locationReadinessLeadMinutes,
      ),
    ) * 60_000;
  return input.nowMs >= input.degradedDeadlineMs - lead;
}

export function buildJitLocationReadinessOpsAlert(input: {
  tripId: string;
  driverId: string;
  reason: string;
  nowIso: string;
  degradedDeadlineIso: string;
  gpsAgeSeconds: number | null;
}): {
  fingerprint: string;
  title: string;
  related_trip_id: string;
  metadata: Record<string, unknown>;
} {
  return {
    fingerprint: `scheduled_jit_location_readiness:${input.tripId}`,
    title: "Scheduled JIT location readiness — GPS required before departure",
    related_trip_id: input.tripId,
    metadata: {
      trip_id: input.tripId,
      driver_id: input.driverId,
      reason: input.reason,
      observed_at: input.nowIso,
      degraded_deadline_at: input.degradedDeadlineIso,
      gps_age_seconds: input.gpsAgeSeconds,
      phase: "jit_location_readiness",
      audible: false,
    },
  };
}

export function buildJitLateRiskOpsAlert(input: {
  tripId: string;
  driverId: string;
  nowIso: string;
  lateRisk: JitLateRiskAssessment;
  etaMinutes: number | null;
  tier: JitPickupEtaTier;
}): {
  fingerprint: string;
  title: string;
  related_trip_id: string;
  metadata: Record<string, unknown>;
} {
  return {
    fingerprint: `scheduled_jit_late_risk:${input.tripId}`,
    title: "Scheduled JIT late-risk — cannot meet five-minute early arrival",
    related_trip_id: input.tripId,
    metadata: {
      trip_id: input.tripId,
      driver_id: input.driverId,
      observed_at: input.nowIso,
      eta_minutes: input.etaMinutes,
      tier: input.tier,
      target_arrival_at: new Date(input.lateRisk.targetArrivalMs).toISOString(),
      predicted_arrival_at: input.lateRisk.predictedArrivalMs != null
        ? new Date(input.lateRisk.predictedArrivalMs).toISOString()
        : null,
      late_vs_target_minutes: input.lateRisk.lateVsTargetMinutes,
      late_vs_pickup_minutes: input.lateRisk.lateVsPickupMinutes,
      phase: "jit_late_risk",
    },
  };
}

function haversineMeters(
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
