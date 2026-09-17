/**
 * Edge helper: call canonical Postgres evaluate_trip_schedule_conflict.
 */
import type { AnySupabaseClient } from "./supabaseClientTypes.ts";
import {
  CUSTOMER_SCHEDULED_OVERLAP_MESSAGE,
  DRIVER_SCHEDULED_OVERLAP_MESSAGE,
  parseOverlapRpcResult,
  SCHEDULED_TRIP_OVERLAP_ERROR,
  type OverlapCandidateMode,
  type OverlapEvaluation,
  type OverlapSubjectKind,
} from "./tripScheduleOverlapSSOT.ts";

export async function evaluateTripScheduleConflictRpc(
  supabase: AnySupabaseClient,
  args: {
    subjectKind: OverlapSubjectKind;
    subjectId: string;
    candidateStartIso: string;
    candidateEstimatedEndIso: string;
    serviceAreaId?: string | null;
    excludeTripId?: string | null;
    candidateMode?: OverlapCandidateMode;
  },
): Promise<{ ok: true; result: OverlapEvaluation } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc("evaluate_trip_schedule_conflict", {
    p_subject_kind: args.subjectKind,
    p_subject_id: args.subjectId,
    p_candidate_start: args.candidateStartIso,
    p_candidate_estimated_end: args.candidateEstimatedEndIso,
    p_service_area_id: args.serviceAreaId ?? null,
    p_exclude_trip_id: args.excludeTripId ?? null,
    p_candidate_mode: args.candidateMode ?? "scheduled",
  });

  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true, result: parseOverlapRpcResult(data) };
}

export function overlapRejectPayload(subject: OverlapSubjectKind, result: OverlapEvaluation) {
  return {
    code: SCHEDULED_TRIP_OVERLAP_ERROR,
    error: SCHEDULED_TRIP_OVERLAP_ERROR,
    message: subject === "customer"
      ? CUSTOMER_SCHEDULED_OVERLAP_MESSAGE
      : DRIVER_SCHEDULED_OVERLAP_MESSAGE,
    conflicting_trip_id: result.conflicting_trip_id,
    buffer_minutes: result.buffer_minutes,
  };
}

export { SCHEDULED_TRIP_OVERLAP_ERROR };
