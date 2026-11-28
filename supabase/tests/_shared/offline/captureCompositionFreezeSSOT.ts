/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Capture composition freeze / resume / fail-closed SSOT (PR #80 blockers).
 *
 * Atomic order (callers must claim financial lock first):
 * 1. lock held (CAPTURING)
 * 2. reload session + lineage
 * 3. reload RESERVED allocations
 * 4. resume frozen plan OR create once
 * 5. persist + freeze
 * 6. only then provider POST
 */
import { ALLOCATION_STATUS } from "../../../functions/_shared/customerReceivableSSOT.ts";

import {
  CAPTURE_COMPOSITION_VERSION,
  buildCaptureIdempotencyKey,
  planCaptureComposition,
  planTypedMoneyTargets,
  type CaptureCompositionPlan,
  type ReservedAllocationInput,
} from "../../../functions/_shared/captureCompositionSSOT.ts";
import { FrozenCapturePlan, CaptureCompositionErrorCode, readFrozenCapturePlan, validateFrozenCapturePlan, detectReceivableCaptureEvidence, CAPTURE_COMPOSITION_ERROR, nonNeg } from "../../../functions/_shared/captureCompositionFreezeSSOT.ts";


/**
 * Decide create / resume / legacy / fail — pure.
 * Never recompute when a frozen plan exists.
 */
export function decideCaptureCompositionAction(args: {
  payment_session_id: string;
  provider_order_id: string;
  session: Record<string, unknown> | null | undefined;
  reserved_allocations: ReservedAllocationInput[];
  authorised_total_pence: number;
  /** Proposed components only used when creating a new plan. */
  proposed_trip_fare_pence: number;
  proposed_tip_pence: number;
  proposed_buffer_pence: number;
}): 
  | { kind: "resume_frozen"; plan: FrozenCapturePlan }
  | { kind: "create_new" }
  | { kind: "legacy_fare_tip"; target_pence: number }
  | { kind: "fail"; code: CaptureCompositionErrorCode; reason: string }
{
  const frozen = readFrozenCapturePlan({
    payment_session_id: args.payment_session_id,
    provider_order_id: args.provider_order_id,
    session: args.session,
  });
  if (frozen) {
    const v = validateFrozenCapturePlan({
      frozen,
      payment_session_id: args.payment_session_id,
      provider_order_id: args.provider_order_id,
      authorised_total_pence: args.authorised_total_pence,
    });
    if (!v.ok) return { kind: "fail", code: v.code, reason: v.reason };
    return { kind: "resume_frozen", plan: v.plan };
  }

  const meta = args.session?.metadata && typeof args.session.metadata === "object"
    ? args.session.metadata as Record<string, unknown>
    : {};
  const evidence = detectReceivableCaptureEvidence({
    metadata: meta,
    reserved_allocations: args.reserved_allocations,
  });

  if (evidence.reasons.includes("fold_metadata_without_amounts")) {
    return {
      kind: "fail",
      code: CAPTURE_COMPOSITION_ERROR.RECEIVABLE_ALLOCATION_STATE_UNKNOWN,
      reason: "fold_metadata_without_proven_allocations",
    };
  }

  if (evidence.metadata_receivables_pence > 0 && evidence.reserved_total_pence <= 0) {
    return {
      kind: "fail",
      code: CAPTURE_COMPOSITION_ERROR.RECEIVABLE_ALLOCATION_STATE_UNKNOWN,
      reason: "metadata_receivables_without_reserved_allocations",
    };
  }

  if (evidence.reserved_total_pence > 0 || evidence.metadata_receivables_pence > 0) {
    // Must create a plan that includes receivable — caller creates via planner.
    return { kind: "create_new" };
  }

  // No receivable evidence — legacy fare+tip path allowed.
  const tip = nonNeg(args.proposed_tip_pence);
  const fare = nonNeg(args.proposed_trip_fare_pence);
  return { kind: "legacy_fare_tip", target_pence: fare + tip };
}


/**
 * After creating a plan, verify receivable evidence is reflected (fail closed).
 */
export function assertPlanCoversReceivableEvidence(args: {
  plan: CaptureCompositionPlan;
  reserved_total_pence: number;
  metadata_receivables_pence: number;
}): { ok: true } | { ok: false; code: CaptureCompositionErrorCode; reason: string } {
  const need = Math.max(args.reserved_total_pence, args.metadata_receivables_pence);
  if (need > 0 && args.plan.receivable_component_pence !== need
    && args.plan.receivable_component_pence < need) {
    // Planner sums RESERVED only — must equal reserved total.
    if (args.plan.receivable_component_pence !== args.reserved_total_pence) {
      return {
        ok: false,
        code: CAPTURE_COMPOSITION_ERROR.CAPTURE_COMPOSITION_MISMATCH,
        reason: "receivable_component_does_not_match_reserved",
      };
    }
  }
  if (args.metadata_receivables_pence > 0
    && args.reserved_total_pence > 0
    && args.metadata_receivables_pence !== args.reserved_total_pence) {
    return {
      ok: false,
      code: CAPTURE_COMPOSITION_ERROR.CAPTURE_COMPOSITION_MISMATCH,
      reason: "metadata_receivables_disagree_with_reserved",
    };
  }
  if (args.metadata_receivables_pence > 0 && args.plan.receivable_component_pence <= 0) {
    return {
      ok: false,
      code: CAPTURE_COMPOSITION_ERROR.CAPTURE_COMPOSITION_REQUIRED,
      reason: "receivable_evidence_but_plan_receivable_zero",
    };
  }
  const typed = planTypedMoneyTargets({
    trip_fare_component_pence: args.plan.trip_fare_component_pence,
    tip_component_pence: args.plan.tip_component_pence,
    customer_receivable_component_pence: args.plan.receivable_component_pence,
    preauth_buffer_component_pence: args.plan.preauth_buffer_component_pence,
  });
  if (typed.provider_capture_target_pence !== args.plan.provider_capture_target_pence) {
    return {
      ok: false,
      code: CAPTURE_COMPOSITION_ERROR.CAPTURE_COMPOSITION_MISMATCH,
      reason: "component_sum_1p_mismatch",
    };
  }
  return { ok: true };
}


/** Reject attempts to replace a frozen plan with a different target. */
export function rejectPlanMutationAfterFreeze(args: {
  existing: FrozenCapturePlan;
  attempted_target_pence: number;
  attempted_idempotency_key: string;
}): { ok: true } | { ok: false; code: CaptureCompositionErrorCode } {
  if (
    args.existing.provider_capture_target_pence !== args.attempted_target_pence
    || args.existing.capture_idempotency_key !== args.attempted_idempotency_key
  ) {
    return { ok: false, code: CAPTURE_COMPOSITION_ERROR.CAPTURE_COMPOSITION_FROZEN_IMMUTABLE };
  }
  return { ok: true };
}

export * from "../../../functions/_shared/captureCompositionFreezeSSOT.ts";
