/**
 * Lock → reload → resume/create frozen capture composition (PR #80).
 * Callers must not POST to provider before this returns ok.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  claimPaymentSessionFinancialLock,
  releasePaymentSessionFinancialLock,
  type FinancialLockClaim,
} from "./paymentSessionFinancialLockSSOT.ts";
import {
  captureCompositionPersistPatch,
  planCaptureComposition,
  type CaptureCompositionPlan,
  type CaptureCompositionResult,
  type ReservedAllocationInput,
} from "./captureCompositionSSOT.ts";
import {
  CAPTURE_COMPOSITION_ERROR,
  assertPlanCoversReceivableEvidence,
  decideCaptureCompositionAction,
  detectReceivableCaptureEvidence,
  frozenPlanToCaptureCompositionPlan,
  type CaptureCompositionErrorCode,
} from "./captureCompositionFreezeSSOT.ts";

export type AcquireCaptureCompositionResult =
  | {
    ok: true;
    kind: "resumed" | "created" | "legacy_fare_tip";
    plan: CaptureCompositionPlan | null;
    provider_capture_target_pence: number;
    capture_idempotency_key: string | null;
    lock_owner: string;
    lock_claimed_here: boolean;
  }
  | {
    ok: false;
    code: CaptureCompositionErrorCode | "CAPTURE_BUSY" | "PAYMENT_SESSION_MISSING";
    error: string;
    lock_claimed_here: boolean;
    lock_owner?: string;
  };

async function loadReservedAllocations(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<ReservedAllocationInput[]> {
  const { data: allocRows } = await supabase
    .from("payment_session_receivable_allocations")
    .select("id, payment_session_id, status, allocated_amount_pence")
    .eq("payment_session_id", sessionId)
    .eq("status", "RESERVED");
  return (allocRows ?? []).map((r) => ({
    id: String((r as { id?: string }).id ?? ""),
    payment_session_id: String(
      (r as { payment_session_id?: string }).payment_session_id ?? sessionId,
    ),
    status: String((r as { status?: string }).status ?? ""),
    allocated_amount_pence: Math.round(
      Number((r as { allocated_amount_pence?: number }).allocated_amount_pence) || 0,
    ),
  }));
}

async function persistFrozenPlan(
  supabase: SupabaseClient,
  sessionId: string,
  plan: CaptureCompositionPlan,
  priorMeta: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  const patch = captureCompositionPersistPatch(plan);
  const nextMeta = {
    ...priorMeta,
    ...patch,
    capture_composition_persisted_at: now,
    capture_composition_frozen_at: now,
    capture_composition_immutable: true,
  };
  const { error } = await supabase
    .from("payment_sessions")
    .update({
      trip_fare_component_pence: plan.trip_fare_component_pence,
      tip_component_pence: plan.tip_component_pence,
      receivable_component_pence: plan.receivable_component_pence,
      provider_capture_target_pence: plan.provider_capture_target_pence,
      capture_composition_version: plan.composition_version,
      capture_idempotency_key: plan.capture_idempotency_key,
      capture_composition_frozen_at: now,
      metadata: nextMeta,
      updated_at: now,
    })
    .eq("id", sessionId)
    .is("capture_idempotency_key", null); // first writer wins
  if (error) {
    // Concurrent first-writer may have won — reload handled by caller resume path.
    console.warn("[captureCompositionAcquire] persist frozen plan", error.message);
  }
}

/**
 * Canonical acquire: lock → reload → resume or create immutable plan.
 */
export async function acquireLockAndResolveCaptureComposition(
  supabase: SupabaseClient,
  args: {
    payment_session_id: string;
    provider_order_id: string;
    trip_fare_component_pence: number;
    tip_component_pence?: number;
    tip_authorisation_declined?: boolean;
    authorised_total_pence: number;
    preauth_buffer_component_pence?: number | null;
    customer_payable_pence?: number | null;
    lock_owner: string;
    operation_key?: string | null;
    /** When caller already holds CAPTURING lock (e.g. admin capture). */
    lock_already_held?: boolean;
  },
): Promise<AcquireCaptureCompositionResult> {
  const sessionId = String(args.payment_session_id ?? "").trim();
  const orderId = String(args.provider_order_id ?? "").trim();
  const owner = String(args.lock_owner ?? "").trim() || `capture:${sessionId}`;
  let lockClaimedHere = false;

  if (!sessionId) {
    return {
      ok: false,
      code: "PAYMENT_SESSION_MISSING",
      error: "payment_session_id required",
      lock_claimed_here: false,
    };
  }

  if (!args.lock_already_held) {
    const lock: FinancialLockClaim = await claimPaymentSessionFinancialLock(supabase, {
      paymentSessionId: sessionId,
      owner,
      state: "CAPTURING",
      operationKey: args.operation_key ?? `capture-composition:${orderId}`,
    });
    if (!lock.ok) {
      return {
        ok: false,
        code: "CAPTURE_BUSY",
        error: `Financial operation busy (${lock.currentState ?? "unknown"})`,
        lock_claimed_here: false,
      };
    }
    lockClaimedHere = true;
  }

  const releaseIfNeeded = async () => {
    if (lockClaimedHere) {
      await releasePaymentSessionFinancialLock(supabase, {
        paymentSessionId: sessionId,
        owner,
        nextState: "IDLE",
      });
    }
  };

  try {
    // 2. Reload session + lineage under lock
    const { data: sessionRow, error: sessionErr } = await supabase
      .from("payment_sessions")
      .select(
        "id, provider_order_id, metadata, buffer_pence, authorised_amount_pence, total_authorised_amount_pence, "
          + "trip_fare_component_pence, tip_component_pence, receivable_component_pence, "
          + "provider_capture_target_pence, capture_idempotency_key, capture_composition_version, "
          + "capture_composition_frozen_at, financial_operation_state",
      )
      .eq("id", sessionId)
      .maybeSingle();

    if (sessionErr || !sessionRow) {
      await releaseIfNeeded();
      return {
        ok: false,
        code: "PAYMENT_SESSION_MISSING",
        error: sessionErr?.message ?? "payment session not found",
        lock_claimed_here: lockClaimedHere,
        lock_owner: owner,
      };
    }

    const sessionOrder = String(sessionRow.provider_order_id ?? "").trim();
    if (sessionOrder && orderId && sessionOrder !== orderId) {
      await releaseIfNeeded();
      return {
        ok: false,
        code: CAPTURE_COMPOSITION_ERROR.CAPTURE_COMPOSITION_LINEAGE_MISMATCH,
        error: "session provider_order_id mismatch",
        lock_claimed_here: lockClaimedHere,
        lock_owner: owner,
      };
    }

    // 3. Reload RESERVED allocations under lock
    const allocations = await loadReservedAllocations(supabase, sessionId);
    const meta = sessionRow.metadata && typeof sessionRow.metadata === "object"
      ? { ...(sessionRow.metadata as Record<string, unknown>) }
      : {};
    const evidence = detectReceivableCaptureEvidence({
      metadata: meta,
      reserved_allocations: allocations,
    });

    const tip = args.tip_authorisation_declined === true
      ? 0
      : Math.max(0, Math.round(Number(args.tip_component_pence ?? 0) || 0));
    const fare = Math.max(0, Math.round(Number(args.trip_fare_component_pence) || 0));
    const buffer = args.preauth_buffer_component_pence != null
      ? Math.max(0, Math.round(Number(args.preauth_buffer_component_pence) || 0))
      : Math.max(0, Math.round(Number(sessionRow.buffer_pence) || 0));
    const authorised = Math.max(
      0,
      Math.round(Number(args.authorised_total_pence) || 0),
      Math.round(Number(sessionRow.total_authorised_amount_pence) || 0),
      Math.round(Number(sessionRow.authorised_amount_pence) || 0),
    );

    // 4–5. Decide resume / create / legacy / fail
    const decision = decideCaptureCompositionAction({
      payment_session_id: sessionId,
      provider_order_id: orderId,
      session: sessionRow as Record<string, unknown>,
      reserved_allocations: allocations,
      authorised_total_pence: authorised,
      proposed_trip_fare_pence: fare,
      proposed_tip_pence: tip,
      proposed_buffer_pence: buffer,
    });

    if (decision.kind === "fail") {
      await releaseIfNeeded();
      return {
        ok: false,
        code: decision.code,
        error: decision.reason,
        lock_claimed_here: lockClaimedHere,
        lock_owner: owner,
      };
    }

    if (decision.kind === "resume_frozen") {
      return {
        ok: true,
        kind: "resumed",
        plan: frozenPlanToCaptureCompositionPlan(decision.plan),
        provider_capture_target_pence: decision.plan.provider_capture_target_pence,
        capture_idempotency_key: decision.plan.capture_idempotency_key,
        lock_owner: owner,
        lock_claimed_here: lockClaimedHere,
      };
    }

    if (decision.kind === "legacy_fare_tip") {
      // No receivable evidence — fare+tip only; do not invent composition columns.
      return {
        ok: true,
        kind: "legacy_fare_tip",
        plan: null,
        provider_capture_target_pence: decision.target_pence,
        capture_idempotency_key: null,
        lock_owner: owner,
        lock_claimed_here: lockClaimedHere,
      };
    }

    // create_new — RESERVED / evidence present
    if (evidence.reserved_total_pence <= 0 && evidence.metadata_receivables_pence > 0) {
      await releaseIfNeeded();
      return {
        ok: false,
        code: CAPTURE_COMPOSITION_ERROR.RECEIVABLE_ALLOCATION_STATE_UNKNOWN,
        error: "receivable metadata without RESERVED allocations",
        lock_claimed_here: lockClaimedHere,
        lock_owner: owner,
      };
    }

    const payable = args.customer_payable_pence != null
      ? args.customer_payable_pence
      : meta.customer_payable_pence != null
      ? Number(meta.customer_payable_pence)
      : null;

    const planned: CaptureCompositionResult = planCaptureComposition({
      trip_fare_component_pence: fare,
      tip_component_pence: tip,
      tip_authorisation_declined: args.tip_authorisation_declined === true,
      preauth_buffer_component_pence: buffer,
      payment_session_id: sessionId,
      provider_order_id: orderId,
      authorised_total_pence: authorised,
      allocations,
      customer_payable_pence: payable,
    });

    if (!planned.ok) {
      await releaseIfNeeded();
      return {
        ok: false,
        code: planned.reject_reason === "capture_target_exceeds_authorised"
          ? CAPTURE_COMPOSITION_ERROR.CAPTURE_TARGET_EXCEEDS_AUTHORISED
          : CAPTURE_COMPOSITION_ERROR.CAPTURE_COMPOSITION_REQUIRED,
        error: planned.reject_reason,
        lock_claimed_here: lockClaimedHere,
        lock_owner: owner,
      };
    }

    const cover = assertPlanCoversReceivableEvidence({
      plan: planned,
      reserved_total_pence: evidence.reserved_total_pence,
      metadata_receivables_pence: evidence.metadata_receivables_pence,
    });
    if (!cover.ok) {
      await releaseIfNeeded();
      return {
        ok: false,
        code: cover.code,
        error: cover.reason,
        lock_claimed_here: lockClaimedHere,
        lock_owner: owner,
      };
    }

    // 6. Persist + freeze (first writer wins on idempotency key null)
    await persistFrozenPlan(supabase, sessionId, planned, meta);

    // Re-read — concurrent winner may have frozen first; adopt that plan.
    const { data: after } = await supabase
      .from("payment_sessions")
      .select(
        "id, provider_order_id, metadata, trip_fare_component_pence, tip_component_pence, "
          + "receivable_component_pence, provider_capture_target_pence, capture_idempotency_key, "
          + "capture_composition_version, capture_composition_frozen_at, buffer_pence",
      )
      .eq("id", sessionId)
      .maybeSingle();

    const adopt = decideCaptureCompositionAction({
      payment_session_id: sessionId,
      provider_order_id: orderId,
      session: (after ?? sessionRow) as Record<string, unknown>,
      reserved_allocations: allocations,
      authorised_total_pence: authorised,
      proposed_trip_fare_pence: fare,
      proposed_tip_pence: tip,
      proposed_buffer_pence: buffer,
    });

    if (adopt.kind === "resume_frozen") {
      return {
        ok: true,
        kind: after && String(after.capture_idempotency_key) === planned.capture_idempotency_key
          ? "created"
          : "resumed",
        plan: frozenPlanToCaptureCompositionPlan(adopt.plan),
        provider_capture_target_pence: adopt.plan.provider_capture_target_pence,
        capture_idempotency_key: adopt.plan.capture_idempotency_key,
        lock_owner: owner,
        lock_claimed_here: lockClaimedHere,
      };
    }

    // Our persist should have frozen; if not visible, use planned in-memory.
    return {
      ok: true,
      kind: "created",
      plan: planned,
      provider_capture_target_pence: planned.provider_capture_target_pence,
      capture_idempotency_key: planned.capture_idempotency_key,
      lock_owner: owner,
      lock_claimed_here: lockClaimedHere,
    };
  } catch (err) {
    await releaseIfNeeded();
    return {
      ok: false,
      code: CAPTURE_COMPOSITION_ERROR.CAPTURE_COMPOSITION_REQUIRED,
      error: err instanceof Error ? err.message : String(err),
      lock_claimed_here: lockClaimedHere,
      lock_owner: owner,
    };
  }
}

/** Fail closed when receivable evidence exists but no payment session. */
export function failClosedWithoutSessionWhenReceivableEvidence(args: {
  metadata?: Record<string, unknown> | null;
  customer_receivables_pence?: number | null;
}): AcquireCaptureCompositionResult | null {
  const evidence = detectReceivableCaptureEvidence({
    metadata: args.metadata ?? {},
    customer_receivables_pence: args.customer_receivables_pence,
    reserved_allocations: [],
  });
  if (!evidence.has_evidence) return null;
  return {
    ok: false,
    code: CAPTURE_COMPOSITION_ERROR.CAPTURE_COMPOSITION_REQUIRED,
    error: "receivable_evidence_without_payment_session",
    lock_claimed_here: false,
  };
}
