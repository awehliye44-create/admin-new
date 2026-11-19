/**
 * Phase 4 — gate instant / stacked / scheduled / Admin assign against
 * confirmed scheduled commitments. Backend-authoritative.
 *
 * Bug #44 — pre-dispatch eligibility reuses the same composition + feasibility
 * rules as accept-time conflict protection (travel-to-pickup, waiting,
 * duration, dropoff→scheduled, JIT-protected stage). Acceptance-time gate stays.
 */

import {
  COMMITMENT_TRAVEL_ETA_FALLBACK_MINUTES,
  composeInstantAdditionalWorkRemainingMinutes,
  evaluateScheduledCommitmentFeasibility,
  isJitDepartureActivationProtected,
  resolveCommitmentPickupWaitingMinutes,
  resolveJitConfigFromDispatchRow,
  selectEarliestConfirmedCommitment,
  type ConfirmedScheduledCommitment,
} from "./scheduledCommitmentFeasibilitySSOT.ts";
import { estimateEtaMinutes } from "./scheduledDispatchConfig.ts";

export type CommitmentGateResult = {
  allowed: boolean;
  reason: string | null;
  commitmentTripId: string | null;
};

export async function loadDriverConfirmedScheduledCommitments(
  supabase: any,
  driverId: string,
  nowMs: number,
): Promise<ConfirmedScheduledCommitment[]> {
  const { data } = await supabase
    .from("trips")
    .select(
      "id, scheduled_at, pickup_latitude, pickup_longitude, scheduled_status, status, driver_id, scheduled_jit_activate_at",
    )
    .eq("dispatch_mode", "scheduled")
    .eq("confirmed_driver_id", driverId)
    .is("driver_id", null)
    .in("scheduled_status", [
      "driver_assigned",
      "scheduled",
      "scheduled_committed",
      "awaiting_activation_accept",
    ])
    .gt("scheduled_at", new Date(nowMs - 15 * 60_000).toISOString())
    .limit(20);

  const out: ConfirmedScheduledCommitment[] = [];
  for (const row of data ?? []) {
    const scheduledAtMs = Date.parse(String(row.scheduled_at ?? ""));
    if (!Number.isFinite(scheduledAtMs)) continue;
    const jitRaw = row.scheduled_jit_activate_at;
    const jitActivateAtMs =
      jitRaw == null || jitRaw === ""
        ? null
        : Date.parse(String(jitRaw));
    out.push({
      tripId: String(row.id),
      scheduledAtMs,
      pickupLat: row.pickup_latitude == null ? null : Number(row.pickup_latitude),
      pickupLng: row.pickup_longitude == null ? null : Number(row.pickup_longitude),
      scheduledStatus: row.scheduled_status == null
        ? null
        : String(row.scheduled_status),
      jitActivateAtMs: Number.isFinite(jitActivateAtMs) ? jitActivateAtMs! : null,
    });
  }
  return out;
}

function resolveTravelMinutes(
  fromLat: number | null | undefined,
  fromLng: number | null | undefined,
  toLat: number | null | undefined,
  toLng: number | null | undefined,
  precomputed?: number | null,
): number {
  if (
    precomputed != null &&
    Number.isFinite(precomputed) &&
    Number(precomputed) >= 0
  ) {
    return Math.max(0, Math.ceil(Number(precomputed)));
  }
  if (
    fromLat != null &&
    fromLng != null &&
    toLat != null &&
    toLng != null &&
    Number.isFinite(fromLat) &&
    Number.isFinite(fromLng) &&
    Number.isFinite(toLat) &&
    Number.isFinite(toLng)
  ) {
    return estimateEtaMinutes(fromLat, fromLng, toLat, toLng) ??
      COMMITMENT_TRAVEL_ETA_FALLBACK_MINUTES;
  }
  return COMMITMENT_TRAVEL_ETA_FALLBACK_MINUTES;
}

/**
 * Bug #44 — authoritative instant/stacked offer eligibility vs confirmed scheduled.
 * Used by auto-dispatch (pre-offer) and accept-offer (race safeguard).
 */
export async function evaluateInstantOfferScheduledCommitmentGate(input: {
  supabase: any;
  driverId: string;
  nowMs: number;
  candidateDurationMinutes: number;
  candidatePickupLat: number | null;
  candidatePickupLng: number | null;
  candidateDropoffLat: number | null;
  candidateDropoffLng: number | null;
  /** Origin for travel to instant pickup (idle: current; stacked: active dropoff). */
  originLat: number | null;
  originLng: number | null;
  /** Current driver location for JIT departure protection. */
  driverLat: number | null;
  driverLng: number | null;
  stackedRemainingMinutes?: number;
  /** Optional precomputed travel-to-instant-pickup minutes (haversine cache). */
  travelToCandidatePickupMinutes?: number | null;
  globalDispatchSettings?: Record<string, unknown> | null;
}): Promise<CommitmentGateResult> {
  const commitments = await loadDriverConfirmedScheduledCommitments(
    input.supabase,
    input.driverId,
    input.nowMs,
  );
  const earliest = selectEarliestConfirmedCommitment(commitments, input.nowMs);
  if (!earliest) {
    return { allowed: true, reason: null, commitmentTripId: null };
  }

  const config = resolveJitConfigFromDispatchRow(input.globalDispatchSettings ?? null);

  const travelDriverToScheduled = resolveTravelMinutes(
    input.driverLat,
    input.driverLng,
    earliest.pickupLat,
    earliest.pickupLng,
  );

  const jitGuard = isJitDepartureActivationProtected({
    nowMs: input.nowMs,
    scheduledStatus: earliest.scheduledStatus,
    jitActivateAtMs: earliest.jitActivateAtMs,
    scheduledAtMs: earliest.scheduledAtMs,
    travelEtaToScheduledPickupMinutes: travelDriverToScheduled,
    config,
  });
  if (jitGuard.protected) {
    return {
      allowed: false,
      reason: jitGuard.reason ?? "jit_activation_protected",
      commitmentTripId: earliest.tripId,
    };
  }

  const travelToCandidate = resolveTravelMinutes(
    input.originLat,
    input.originLng,
    input.candidatePickupLat,
    input.candidatePickupLng,
    input.travelToCandidatePickupMinutes,
  );
  const waiting = resolveCommitmentPickupWaitingMinutes(
    input.globalDispatchSettings ?? null,
  );
  const remaining = composeInstantAdditionalWorkRemainingMinutes({
    stackedRemainingMinutes: input.stackedRemainingMinutes ?? 0,
    travelToCandidatePickupMinutes: travelToCandidate,
    pickupWaitingMinutes: waiting,
    candidateDurationMinutes: input.candidateDurationMinutes,
  });

  const travelDropoffToScheduled = resolveTravelMinutes(
    input.candidateDropoffLat ?? input.candidatePickupLat,
    input.candidateDropoffLng ?? input.candidatePickupLng,
    earliest.pickupLat,
    earliest.pickupLng,
  );

  const feasibility = evaluateScheduledCommitmentFeasibility({
    nowMs: input.nowMs,
    remainingJourneyMinutes: remaining,
    travelToPickupEtaMinutes: travelDropoffToScheduled,
    scheduledAtMs: earliest.scheduledAtMs,
    config,
  });

  if (feasibility.feasible) {
    return { allowed: true, reason: null, commitmentTripId: earliest.tripId };
  }
  return {
    allowed: false,
    reason: "scheduled_commitment_infeasible",
    commitmentTripId: earliest.tripId,
  };
}

/**
 * Gate accepting / assigning an additional scheduled booking against the
 * driver's other confirmed scheduled commitments (multi-booking).
 */
export async function driverMayTakeAdditionalScheduledBooking(input: {
  supabase: any;
  driverId: string;
  nowMs: number;
  candidateTripId: string;
  candidateScheduledAtMs: number;
  candidateDurationMinutes: number;
  candidatePickupLat: number | null;
  candidatePickupLng: number | null;
  candidateDropoffLat: number | null;
  candidateDropoffLng: number | null;
  globalDispatchSettings?: Record<string, unknown> | null;
}): Promise<CommitmentGateResult> {
  const commitments = (
    await loadDriverConfirmedScheduledCommitments(
      input.supabase,
      input.driverId,
      input.nowMs,
    )
  ).filter((c) => c.tripId !== input.candidateTripId);

  if (commitments.length === 0) {
    return { allowed: true, reason: null, commitmentTripId: null };
  }

  const config = resolveJitConfigFromDispatchRow(input.globalDispatchSettings ?? null);
  const candDur = Math.max(5, Math.ceil(input.candidateDurationMinutes || 30));

  for (const other of commitments) {
    // Candidate finishes before other pickup?
    if (input.candidateScheduledAtMs <= other.scheduledAtMs) {
      const travel =
        input.candidateDropoffLat != null &&
          input.candidateDropoffLng != null &&
          other.pickupLat != null &&
          other.pickupLng != null
          ? estimateEtaMinutes(
            input.candidateDropoffLat,
            input.candidateDropoffLng,
            other.pickupLat,
            other.pickupLng,
          ) ?? COMMITMENT_TRAVEL_ETA_FALLBACK_MINUTES
          : COMMITMENT_TRAVEL_ETA_FALLBACK_MINUTES;
      const feasibility = evaluateScheduledCommitmentFeasibility({
        nowMs: input.candidateScheduledAtMs,
        remainingJourneyMinutes: candDur,
        travelToPickupEtaMinutes: travel,
        scheduledAtMs: other.scheduledAtMs,
        config,
      });
      if (!feasibility.feasible) {
        return {
          allowed: false,
          reason: "scheduled_commitment_infeasible",
          commitmentTripId: other.tripId,
        };
      }
      continue;
    }

    // Other finishes before candidate pickup — approximate other duration 30m.
    const travel =
      other.pickupLat != null &&
        other.pickupLng != null &&
        input.candidatePickupLat != null &&
        input.candidatePickupLng != null
        ? estimateEtaMinutes(
          other.pickupLat,
          other.pickupLng,
          input.candidatePickupLat,
          input.candidatePickupLng,
        ) ?? COMMITMENT_TRAVEL_ETA_FALLBACK_MINUTES
        : COMMITMENT_TRAVEL_ETA_FALLBACK_MINUTES;
    const feasibility = evaluateScheduledCommitmentFeasibility({
      nowMs: other.scheduledAtMs,
      remainingJourneyMinutes: 30,
      travelToPickupEtaMinutes: travel,
      scheduledAtMs: input.candidateScheduledAtMs,
      config,
    });
    if (!feasibility.feasible) {
      return {
        allowed: false,
        reason: "scheduled_commitment_infeasible",
        commitmentTripId: other.tripId,
      };
    }
  }

  return { allowed: true, reason: null, commitmentTripId: null };
}
