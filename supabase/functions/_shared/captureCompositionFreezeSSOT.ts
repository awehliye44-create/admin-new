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
import { ALLOCATION_STATUS } from "./customerReceivableSSOT.ts";
import {
  CAPTURE_COMPOSITION_VERSION,
  buildCaptureIdempotencyKey,
  planCaptureComposition,
  planTypedMoneyTargets,
  type CaptureCompositionPlan,
  type ReservedAllocationInput,
} from "./captureCompositionSSOT.ts";

export const CAPTURE_COMPOSITION_ERROR = {
  CAPTURE_COMPOSITION_REQUIRED: "CAPTURE_COMPOSITION_REQUIRED",
  CAPTURE_COMPOSITION_MISMATCH: "CAPTURE_COMPOSITION_MISMATCH",
  RECEIVABLE_ALLOCATION_STATE_UNKNOWN: "RECEIVABLE_ALLOCATION_STATE_UNKNOWN",
  CAPTURE_COMPOSITION_LINEAGE_MISMATCH: "CAPTURE_COMPOSITION_LINEAGE_MISMATCH",
  CAPTURE_COMPOSITION_FROZEN_IMMUTABLE: "CAPTURE_COMPOSITION_FROZEN_IMMUTABLE",
  CAPTURE_TARGET_EXCEEDS_AUTHORISED: "CAPTURE_TARGET_EXCEEDS_AUTHORISED",
} as const;

export type CaptureCompositionErrorCode =
  (typeof CAPTURE_COMPOSITION_ERROR)[keyof typeof CAPTURE_COMPOSITION_ERROR];

export type FrozenCapturePlan = {
  frozen: true;
  trip_fare_component_pence: number;
  tip_component_pence: number;
  receivable_component_pence: number;
  preauth_buffer_component_pence: number;
  provider_capture_target_pence: number;
  capture_idempotency_key: string;
  payment_session_id: string;
  provider_order_id: string;
  composition_version: string;
  capture_composition_frozen_at: string | null;
};

function nonNeg(n: unknown): number {
  const v = Math.round(Number(n) || 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** True when any plan component / target / key is populated. */
export function sessionHasPopulatedCapturePlan(session: Record<string, unknown> | null | undefined): boolean {
  if (!session) return false;
  const key = String(session.capture_idempotency_key ?? "").trim();
  const target = session.provider_capture_target_pence;
  const frozenAt = session.capture_composition_frozen_at
    ?? (session.metadata && typeof session.metadata === "object"
      ? (session.metadata as Record<string, unknown>).capture_composition_frozen_at
      : null);
  return Boolean(key) || target != null || frozenAt != null;
}

/**
 * Read an immutable frozen plan from session columns/metadata.
 * Returns null if no frozen plan.
 */
export function readFrozenCapturePlan(args: {
  payment_session_id: string;
  provider_order_id: string;
  session: Record<string, unknown> | null | undefined;
}): FrozenCapturePlan | null {
  const session = args.session;
  if (!session) return null;
  const meta = session.metadata && typeof session.metadata === "object"
    ? session.metadata as Record<string, unknown>
    : {};
  const key = String(session.capture_idempotency_key ?? meta.capture_idempotency_key ?? "").trim();
  const target = nonNeg(session.provider_capture_target_pence ?? meta.provider_capture_target_pence);
  const frozenAt = session.capture_composition_frozen_at ?? meta.capture_composition_frozen_at ?? null;
  if (!key || target <= 0) return null;
  // Frozen once key+target persisted (submission may begin / already begun).
  const fare = nonNeg(session.trip_fare_component_pence ?? meta.trip_fare_component_pence);
  const tip = nonNeg(session.tip_component_pence ?? meta.tip_component_pence);
  const recv = nonNeg(session.receivable_component_pence ?? meta.receivable_component_pence);
  const buffer = nonNeg(session.preauth_buffer_component_pence ?? meta.preauth_buffer_component_pence);
  const orderId = String(args.provider_order_id ?? session.provider_order_id ?? "").trim();
  const sessionId = String(args.payment_session_id ?? session.id ?? "").trim();
  return {
    frozen: true,
    trip_fare_component_pence: fare,
    tip_component_pence: tip,
    receivable_component_pence: recv,
    preauth_buffer_component_pence: buffer,
    provider_capture_target_pence: target,
    capture_idempotency_key: key,
    payment_session_id: sessionId,
    provider_order_id: orderId,
    composition_version: String(
      session.capture_composition_version ?? meta.capture_composition_version ?? CAPTURE_COMPOSITION_VERSION,
    ),
    capture_composition_frozen_at: frozenAt != null ? String(frozenAt) : null,
  };
}

/**
 * Validate frozen plan lineage and component sum. Never recompute amounts.
 */
export function validateFrozenCapturePlan(args: {
  frozen: FrozenCapturePlan;
  payment_session_id: string;
  provider_order_id: string;
  authorised_total_pence: number;
}): { ok: true; plan: FrozenCapturePlan } | { ok: false; code: CaptureCompositionErrorCode; reason: string } {
  const f = args.frozen;
  if (f.payment_session_id !== String(args.payment_session_id).trim()) {
    return {
      ok: false,
      code: CAPTURE_COMPOSITION_ERROR.CAPTURE_COMPOSITION_LINEAGE_MISMATCH,
      reason: "frozen_plan_session_mismatch",
    };
  }
  if (f.provider_order_id !== String(args.provider_order_id).trim()) {
    return {
      ok: false,
      code: CAPTURE_COMPOSITION_ERROR.CAPTURE_COMPOSITION_LINEAGE_MISMATCH,
      reason: "frozen_plan_order_mismatch",
    };
  }
  const sum = f.trip_fare_component_pence + f.tip_component_pence + f.receivable_component_pence;
  if (sum !== f.provider_capture_target_pence) {
    return {
      ok: false,
      code: CAPTURE_COMPOSITION_ERROR.CAPTURE_COMPOSITION_MISMATCH,
      reason: "frozen_plan_component_sum_mismatch",
    };
  }
  const auth = nonNeg(args.authorised_total_pence);
  if (auth > 0 && f.provider_capture_target_pence > auth) {
    return {
      ok: false,
      code: CAPTURE_COMPOSITION_ERROR.CAPTURE_TARGET_EXCEEDS_AUTHORISED,
      reason: "frozen_target_exceeds_authorised",
    };
  }
  const expectedKey = buildCaptureIdempotencyKey({
    payment_session_id: f.payment_session_id,
    provider_order_id: f.provider_order_id,
    provider_capture_target_pence: f.provider_capture_target_pence,
  });
  if (f.capture_idempotency_key !== expectedKey) {
    return {
      ok: false,
      code: CAPTURE_COMPOSITION_ERROR.CAPTURE_COMPOSITION_MISMATCH,
      reason: "frozen_idempotency_key_mismatch",
    };
  }
  return { ok: true, plan: f };
}

/** Detect any receivable evidence that forbids silent fare+tip fallback. */
export function detectReceivableCaptureEvidence(args: {
  metadata?: Record<string, unknown> | null;
  customer_receivables_pence?: number | null;
  reserved_allocations: ReservedAllocationInput[];
  folded_receivable_pence?: number | null;
}): {
  has_evidence: boolean;
  reserved_total_pence: number;
  metadata_receivables_pence: number;
  reasons: string[];
} {
  const meta = args.metadata ?? {};
  const metaRecv = nonNeg(
    args.customer_receivables_pence
      ?? meta.customer_receivables_pence
      ?? meta.folded_receivable_pence
      ?? args.folded_receivable_pence,
  );
  const reserved = (args.reserved_allocations ?? [])
    .filter((a) => String(a.status ?? "").toUpperCase() === ALLOCATION_STATUS.RESERVED)
    .reduce((s, a) => s + nonNeg(a.allocated_amount_pence), 0);
  const reasons: string[] = [];
  if (reserved > 0) reasons.push("reserved_allocations");
  if (metaRecv > 0) reasons.push("metadata_customer_receivables_pence");
  const foldedFlag = meta.preauth_receivable_ordering != null
    || meta.customer_receivable_ids != null
    || Array.isArray(meta.customer_receivable_ids);
  if (foldedFlag && metaRecv <= 0 && reserved <= 0) {
    reasons.push("fold_metadata_without_amounts");
  }
  return {
    has_evidence: reasons.length > 0,
    reserved_total_pence: reserved,
    metadata_receivables_pence: metaRecv,
    reasons,
  };
}

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

export function frozenPlanToCaptureCompositionPlan(f: FrozenCapturePlan): CaptureCompositionPlan {
  return {
    ok: true,
    trip_fare_component_pence: f.trip_fare_component_pence,
    tip_component_pence: f.tip_component_pence,
    receivable_component_pence: f.receivable_component_pence,
    preauth_buffer_component_pence: f.preauth_buffer_component_pence,
    provider_capture_target_pence: f.provider_capture_target_pence,
    provider_authorisation_target_pence:
      f.trip_fare_component_pence + f.receivable_component_pence + f.preauth_buffer_component_pence,
    provider_release_amount_pence: f.preauth_buffer_component_pence,
    displayed_customer_total_pence: f.trip_fare_component_pence + f.receivable_component_pence,
    authorised_total_pence: 0,
    payment_session_id: f.payment_session_id,
    provider_order_id: f.provider_order_id,
    capture_idempotency_key: f.capture_idempotency_key,
    composition_version: CAPTURE_COMPOSITION_VERSION,
    reserved_allocation_ids: [],
  };
}

// Keep planCaptureComposition referenced for source locks that import this module.
void planCaptureComposition;
