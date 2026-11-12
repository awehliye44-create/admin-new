/**
 * Phase 4 — backend eligibility: do not offer/accept work that makes a
 * confirmed scheduled commitment infeasible.
 *
 * Feasibility:
 *   now + remainingActiveMinutes + travelToPickupEta + earlyArrival + safetyBuffer
 *   ≤ scheduled_at
 *
 * Uses the same JIT buffers as scheduledJitActivationSSOT.
 */

import {
  classifyJitDistanceKind,
  resolveScheduledJitActivationConfig,
  safetyBufferMinutesForJitKind,
  type ScheduledJitActivationConfig,
} from "./scheduledJitActivationSSOT.ts";

export type ConfirmedScheduledCommitment = {
  tripId: string;
  scheduledAtMs: number;
  pickupLat: number | null;
  pickupLng: number | null;
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
