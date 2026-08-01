/**
 * Apply identity decision with terminal-state protection (out-of-order safe).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { OnecabIdentityDecision, OnecabIdentityStatus } from "./types.ts";

const TERMINAL: ReadonlySet<string> = new Set([
  "approved",
  "rejected",
  "expired",
]);

export function decisionToStatus(
  decision: OnecabIdentityDecision,
): OnecabIdentityStatus {
  switch (decision) {
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "retry_required":
      return "retry_required";
    case "manual_review":
      return "manual_review";
    case "expired":
      return "expired";
    case "cancelled":
      return "cancelled";
  }
}

export async function applyIdentityDecision(input: {
  supabase: SupabaseClient;
  verificationId: string;
  driverId: string;
  fromStatus: string;
  decision: OnecabIdentityDecision;
  livenessResult?: string | null;
  faceMatchResult?: string | null;
  imageQualityResult?: string | null;
  failureCode?: string | null;
  decidedAt?: string | null;
  source: string;
}): Promise<{ applied: boolean; status: string }> {
  if (TERMINAL.has(input.fromStatus)) {
    return { applied: false, status: input.fromStatus };
  }

  const toStatus = decisionToStatus(input.decision);
  const { data, error } = await input.supabase
    .from("driver_identity_verifications")
    .update({
      status: toStatus,
      liveness_result: input.livenessResult ?? null,
      face_match_result: input.faceMatchResult ?? null,
      image_quality_result: input.imageQualityResult ?? null,
      failure_code: input.failureCode ?? null,
      decided_at: input.decidedAt ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.verificationId)
    .eq("driver_id", input.driverId)
    .not("status", "in", "(approved,rejected,expired)")
    .select("id, status")
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    return { applied: false, status: input.fromStatus };
  }

  await input.supabase.from("driver_identity_verification_events").insert({
    verification_id: input.verificationId,
    driver_id: input.driverId,
    actor_role: "system",
    event_type: `decision_${input.source}`,
    from_status: input.fromStatus,
    to_status: toStatus,
    metadata: { source: input.source },
  });

  return { applied: true, status: toStatus };
}
