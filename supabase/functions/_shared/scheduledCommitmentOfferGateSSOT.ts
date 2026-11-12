/**
 * Phase 4 — gate instant / stacked / scheduled / Admin assign against
 * confirmed scheduled commitments. Backend-authoritative.
 */

import {
  evaluateScheduledCommitmentFeasibility,
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
      "id, scheduled_at, pickup_latitude, pickup_longitude, scheduled_status, status, driver_id",
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
    out.push({
      tripId: String(row.id),
      scheduledAtMs,
      pickupLat: row.pickup_latitude == null ? null : Number(row.pickup_latitude),
      pickupLng: row.pickup_longitude == null ? null : Number(row.pickup_longitude),
    });
  }
  return out;
}

/**
 * Returns false when offering/accepting `candidate` would make the earliest
 * confirmed scheduled pickup infeasible.
 */
export async function driverMayAcceptAdditionalWork(input: {
  supabase: any;
  driverId: string;
  nowMs: number;
  /** Expected remaining minutes on current + stacked work after adding candidate. */
  remainingJourneyMinutesAfterAccept: number;
  /** Driver/completion location for travel-to-scheduled-pickup ETA. */
  fromLat: number | null;
  fromLng: number | null;
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

  const travel =
    earliest.pickupLat != null &&
      earliest.pickupLng != null &&
      input.fromLat != null &&
      input.fromLng != null
      ? estimateEtaMinutes(
        input.fromLat,
        input.fromLng,
        earliest.pickupLat,
        earliest.pickupLng,
      ) ?? 30
      : 30;

  const config = resolveJitConfigFromDispatchRow(input.globalDispatchSettings ?? null);
  const feasibility = evaluateScheduledCommitmentFeasibility({
    nowMs: input.nowMs,
    remainingJourneyMinutes: input.remainingJourneyMinutesAfterAccept,
    travelToPickupEtaMinutes: travel,
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
          ) ?? 30
          : 30;
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
        ) ?? 30
        : 30;
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
