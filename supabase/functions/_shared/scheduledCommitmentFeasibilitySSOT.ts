/**
 * Phase 4 — backend eligibility: do not offer/accept work that makes a
 * confirmed scheduled commitment infeasible.
 *
 * Feasibility:
 *   now + remainingActiveMinutes + travelToPickupEta + earlyArrival + safetyBuffer
 *   ≤ scheduled_at
 *
 * Bug #44 — remainingActiveMinutes for an instant candidate is composed as:
 *   stackedRemaining + travelToInstantPickup + pickupWaiting + candidateDuration
 * so pre-dispatch eligibility matches acceptance-time conflict protection.
 *
 * Uses the same JIT buffers as scheduledJitActivationSSOT.
 */

import {
  classifyJitDistanceKind,
  computeJitDepartureDeadlineMs,
  resolveScheduledJitActivationConfig,
  safetyBufferMinutesForJitKind,
  type ScheduledJitActivationConfig,
} from "./scheduledJitActivationSSOT.ts";

/** Conservative fallback when haversine/coords unavailable (mirrors offer gate). */
export const COMMITMENT_TRAVEL_ETA_FALLBACK_MINUTES = 30;

/**
 * Instant pickup waiting allowance folded into remaining journey.
 * Defaults to 5 min (300s grace) when dispatch settings omit the grace field.
 */
export const COMMITMENT_INSTANT_PICKUP_WAITING_MINUTES_DEFAULT = 5;

export type ConfirmedScheduledCommitment = {
  tripId: string;
  scheduledAtMs: number;
  pickupLat: number | null;
  pickupLng: number | null;
  scheduledStatus: string | null;
  /** Sticky JIT departure deadline when already computed (trips.scheduled_jit_activate_at). */
  jitActivateAtMs: number | null;
};

export type FeasibilityInput = {
  nowMs: number;
  /** Minutes until current active/stacked work is expected to finish (0 if idle). */
  remainingJourneyMinutes: number;
  /** ETA from expected completion (or current) location to scheduled pickup. */
  travelToPickupEtaMinutes: number;
  scheduledAtMs: number;
  config: ScheduledJitActivationConfig;
};

export type FeasibilityResult = {
  feasible: boolean;
  requiredLeadMinutes: number;
  availableMinutesUntilPickup: number;
  kind: "local" | "long";
  reason?: "ok" | "insufficient_lead" | "invalid_schedule";
};

export function evaluateScheduledCommitmentFeasibility(
  input: FeasibilityInput,
): FeasibilityResult {
  if (!Number.isFinite(input.scheduledAtMs)) {
    return {
      feasible: false,
      requiredLeadMinutes: NaN,
      availableMinutesUntilPickup: NaN,
      kind: "local",
      reason: "invalid_schedule",
    };
  }

  const classified = classifyJitDistanceKind({
    driverToPickupEtaMinutes: input.travelToPickupEtaMinutes,
    longDistanceEtaThresholdMinutes: input.config.longDistanceEtaThresholdMinutes,
  });
  const early = Math.max(0, Math.floor(input.config.targetEarlyArrivalMinutes));
  const buffer = safetyBufferMinutesForJitKind(classified.kind, input.config);
  const travel = Math.max(0, Math.ceil(classified.etaMinutes));
  const remaining = Math.max(0, Math.ceil(Number(input.remainingJourneyMinutes) || 0));
  const requiredLeadMinutes = remaining + travel + early + buffer;
  const availableMinutesUntilPickup = (input.scheduledAtMs - input.nowMs) / 60_000;
  const feasible = availableMinutesUntilPickup >= requiredLeadMinutes;

  return {
    feasible,
    requiredLeadMinutes,
    availableMinutesUntilPickup,
    kind: classified.kind,
    reason: feasible ? "ok" : "insufficient_lead",
  };
}

/**
 * Compose the remaining-journey minutes an instant (or stacked) accept adds
 * before the driver can leave for the scheduled pickup.
 *
 * Does not include dropoff→scheduled travel — that is travelToPickupEtaMinutes
 * in evaluateScheduledCommitmentFeasibility.
 */
export function composeInstantAdditionalWorkRemainingMinutes(input: {
  stackedRemainingMinutes?: number | null;
  travelToCandidatePickupMinutes: number;
  pickupWaitingMinutes: number;
  candidateDurationMinutes: number;
}): number {
  const stacked = Math.max(0, Math.ceil(Number(input.stackedRemainingMinutes) || 0));
  const travel = Math.max(0, Math.ceil(Number(input.travelToCandidatePickupMinutes) || 0));
  const waiting = Math.max(0, Math.ceil(Number(input.pickupWaitingMinutes) || 0));
  const duration = Math.max(5, Math.ceil(Number(input.candidateDurationMinutes) || 30));
  return stacked + travel + waiting + duration;
}

/** Resolve pickup waiting minutes from global_dispatch_settings (or default). */
export function resolveCommitmentPickupWaitingMinutes(
  globalDispatchSettings?: Record<string, unknown> | null,
): number {
  const secRaw = globalDispatchSettings?.pickup_waiting_grace_period_seconds;
  const sec = Number(secRaw);
  if (Number.isFinite(sec) && sec > 0) {
    return Math.max(0, Math.ceil(sec / 60));
  }
  return COMMITMENT_INSTANT_PICKUP_WAITING_MINUTES_DEFAULT;
}

/**
 * Protected JIT departure / activation stage — no new conflicting instant offers.
 * Prefer sticky scheduled_jit_activate_at; else compute the same deadline SSOT.
 */
export function isJitDepartureActivationProtected(input: {
  nowMs: number;
  scheduledStatus: string | null | undefined;
  jitActivateAtMs: number | null | undefined;
  scheduledAtMs: number;
  travelEtaToScheduledPickupMinutes: number;
  config: ScheduledJitActivationConfig;
}): { protected: boolean; reason: string | null } {
  const status = String(input.scheduledStatus ?? "").trim().toLowerCase();
  if (status === "awaiting_activation_accept") {
    return { protected: true, reason: "jit_activation_armed" };
  }

  if (
    input.jitActivateAtMs != null &&
    Number.isFinite(input.jitActivateAtMs) &&
    input.nowMs >= input.jitActivateAtMs
  ) {
    return { protected: true, reason: "jit_departure_deadline_reached" };
  }

  if (!Number.isFinite(input.scheduledAtMs)) {
    return { protected: false, reason: null };
  }

  const computed = computeJitDepartureDeadlineMs({
    scheduledAtMs: input.scheduledAtMs,
    driverToPickupEtaMinutes: input.travelEtaToScheduledPickupMinutes,
    config: input.config,
  });
  if (input.nowMs >= computed.deadlineMs) {
    return { protected: true, reason: "jit_departure_deadline_reached" };
  }
  return { protected: false, reason: null };
}

/**
 * When activating: does the driver's current live journey threaten the commitment?
 * Never interrupt/cancel the in-progress journey — caller uses rescue / ops alert.
 */
export function activeJourneyThreatensScheduledCommitment(input: {
  hasActiveJourney: boolean;
  feasibility: FeasibilityResult;
}): { threatens: boolean; reason: string | null } {
  if (!input.hasActiveJourney) return { threatens: false, reason: null };
  if (input.feasibility.feasible) return { threatens: false, reason: null };
  return {
    threatens: true,
    reason: "active_journey_makes_scheduled_pickup_infeasible",
  };
}

export function resolveJitConfigFromDispatchRow(
  row: Record<string, unknown> | null | undefined,
): ScheduledJitActivationConfig {
  return resolveScheduledJitActivationConfig(row ?? null);
}

/** Earliest confirmed scheduled commitment among a driver's future jobs. */
export function selectEarliestConfirmedCommitment(
  rows: ConfirmedScheduledCommitment[],
  nowMs: number,
): ConfirmedScheduledCommitment | null {
  let best: ConfirmedScheduledCommitment | null = null;
  for (const row of rows) {
    if (!Number.isFinite(row.scheduledAtMs) || row.scheduledAtMs <= nowMs - 15 * 60_000) {
      continue;
    }
    if (!best || row.scheduledAtMs < best.scheduledAtMs) best = row;
  }
  return best;
}
