/**
 * Canonical Payment Sessions lifecycle finalizer.
 *
 * Owned by the Payment Sessions boundary.
 * Finalizes a Payment Session that already has provider capture evidence
 * (provider_state = COMPLETED/CAPTURED, captured_amount_pence > 0, provider_state_verified_at)
 * but whose status column was not advanced to "captured" — typically due to a swallowed
 * DB error in markPaymentSessionCaptured.
 *
 * NEVER contacts the payment provider.
 * NEVER captures, refunds, or releases money.
 * NEVER invents or recalculates amounts.
 * Uses strict compare-and-set predicates; any conflicting state fails closed.
 *
 * After successful finalization, callers must reload the Payment Session before allowing
 * canonical settlement or wallet posting.
 *
 * Lock: paymentSessionLifecycleFinalizerLock.test.ts
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

/** Financial model value for rides where ONECAB collects the fare. */
export const PS_LIFECYCLE_PLATFORM_COLLECTED_MODEL = "PLATFORM_COLLECTED";

/** Eligible booking capture purpose. */
export const PS_LIFECYCLE_ELIGIBLE_PURPOSE = "RIDE_BOOKING";

/** Provider states that confirm the Revolut hold was captured. */
const PROVIDER_CAPTURED_STATES = new Set(["COMPLETED", "CAPTURED"]);
const RECOVERABLE_OPERATION_STATES = new Set(["CAPTURING", "RECONCILING", "CAPTURED"]);

/**
 * Session status values from which lifecycle finalization is safe.
 * Only non-terminal, non-captured states that still hold the payment session open.
 */
const RECOVERABLE_STATUSES = new Set([
  "trip_created",
  "dispatching",
  "completed_pending_capture",
]);

export type PsLifecycleFinalizerResult =
  | { finalized: true; sessionId: string }
  | { finalized: false; reason: string; audit?: Record<string, unknown> };

/**
 * All conditions that must hold before finalization is allowed.
 * Returns null when conditions are met; a reason string when they are not.
 */
export function checkPsLifecycleFinalizerPreconditions(
  session: Record<string, unknown>,
  options?: { tripFinancialModel?: string | null },
): string | null {
  const financialModel = String(
    options?.tripFinancialModel ?? session.financial_model ?? "",
  ).toUpperCase();
  if (financialModel && financialModel !== PS_LIFECYCLE_PLATFORM_COLLECTED_MODEL) {
    return `financial_model_not_eligible:${financialModel}`;
  }

  const purpose = String(session.purpose ?? "").toUpperCase();
  if (purpose && purpose !== PS_LIFECYCLE_ELIGIBLE_PURPOSE) {
    return `purpose_not_eligible:${purpose}`;
  }

  const providerState = String(session.provider_state ?? "").toUpperCase();
  if (!PROVIDER_CAPTURED_STATES.has(providerState)) {
    return `provider_state_not_captured:${providerState}`;
  }

  const verifiedAt = session.provider_state_verified_at;
  if (!verifiedAt) {
    return "provider_state_not_verified";
  }

  const capturedAmount = Number(session.captured_amount_pence ?? 0);
  if (!Number.isFinite(capturedAmount) || capturedAmount <= 0) {
    return "captured_amount_missing_or_zero";
  }

  const metadata = session.metadata && typeof session.metadata === "object"
    ? session.metadata as Record<string, unknown>
    : {};
  const metadataCapture = metadata.capture_amount_pence != null
    ? Number(metadata.capture_amount_pence)
    : null;
  if (metadataCapture != null && Number.isFinite(metadataCapture) && Math.round(metadataCapture) !== Math.round(capturedAmount)) {
    return "captured_amount_disagrees_with_persisted_provider_evidence";
  }

  const refundedAmount = Number(session.refunded_amount_pence ?? 0);
  if (Number.isFinite(refundedAmount) && refundedAmount > 0) {
    return "refund_exists_cannot_finalize";
  }

  const holdReleaseState = String(session.hold_release_state ?? "");
  if (holdReleaseState === "released") {
    return "hold_already_released";
  }

  const holdTerminalReason = String(session.hold_terminal_reason ?? "").toUpperCase();
  if (
    holdTerminalReason.includes("CANCEL")
    || holdTerminalReason.includes("FAILED")
    || holdTerminalReason.includes("REFUND")
    || holdTerminalReason.includes("RELEASE")
  ) {
    return `contradictory_hold_terminal_reason:${holdTerminalReason}`;
  }

  const operationState = String(session.financial_operation_state ?? "").toUpperCase();
  if (operationState && !RECOVERABLE_OPERATION_STATES.has(operationState)) {
    return `financial_operation_state_not_recoverable:${operationState}`;
  }

  const currentStatus = String(session.status ?? "");
  if (currentStatus === "captured") {
    return "already_captured";
  }
  if (!RECOVERABLE_STATUSES.has(currentStatus)) {
    return `status_not_recoverable:${currentStatus}`;
  }

  return null;
}

function resolveCanonicalCaptureIdentity(session: Record<string, unknown>): { identity: string | null; source: "provider_capture_id" | "provider_order_id" | null } {
  const captureId = String(session.provider_capture_id ?? "").trim();
  if (captureId) return { identity: captureId, source: "provider_capture_id" };
  const orderId = String(session.provider_order_id ?? "").trim();
  if (orderId) return { identity: orderId, source: "provider_order_id" };
  return { identity: null, source: null };
}

/**
 * Finalize a lifecycle-mismatched Payment Session from saved in-DB provider evidence.
 *
 * Conditions checked:
 * - trip financial_model = PLATFORM_COLLECTED (from trips snapshot when provided)
 * - purpose = RIDE_BOOKING
 * - provider_state is COMPLETED or CAPTURED
 * - provider_state_verified_at is set
 * - captured_amount_pence > 0
 * - no refund exists (refunded_amount_pence = 0/null)
 * - hold_release_state is not "released"
 * - current status is in the explicitly recoverable set (NOT already "captured")
 * - strict compare-and-set: status must be the expected recoverable status
 *
 * On conflicting state: fails closed and returns { finalized: false, reason, audit }.
 * On compare-and-set failure (concurrent update): fails closed and returns { finalized: false }.
 * On success: advances status → "captured", financial_operation_state → "CAPTURED",
 *   clears financial_operation_owner/started_at.
 */
export async function finalizePaymentSessionLifecycleMismatch(
  supabase: SupabaseClient,
  session: Record<string, unknown>,
  context: { tripId: string; source: string; tripFinancialModel?: string | null },
): Promise<PsLifecycleFinalizerResult> {
  const sessionId = String(session.id ?? "").trim();
  if (!sessionId) {
    return { finalized: false, reason: "session_id_missing" };
  }

  // Check all preconditions before touching the DB.
  const preconditionFailure = checkPsLifecycleFinalizerPreconditions(session, {
    tripFinancialModel: context.tripFinancialModel,
  });
  if (preconditionFailure === "already_captured") {
    // Idempotent: already in desired state.
    return { finalized: true, sessionId };
  }
  if (preconditionFailure) {
    const audit = {
      session_id: sessionId,
      trip_id: context.tripId,
      source: context.source,
      precondition_failure: preconditionFailure,
      session_status: session.status,
      provider_state: session.provider_state,
      captured_amount_pence: session.captured_amount_pence,
      financial_operation_state: session.financial_operation_state,
    };
    console.warn("[paymentSessionLifecycleFinalizer] precondition failed — closing", audit);
    return { finalized: false, reason: preconditionFailure, audit };
  }

  const currentStatus = String(session.status ?? "");
  const currentFinancialOperationState = String(session.financial_operation_state ?? "").toUpperCase() || null;
  const canonicalIdentity = resolveCanonicalCaptureIdentity(session);
  if (!canonicalIdentity.identity || !canonicalIdentity.source) {
    return { finalized: false, reason: "canonical_capture_identity_missing" };
  }

  const identityColumn = canonicalIdentity.source;
  const { data: identityMatches, error: identityErr } = await supabase
    .from("payment_sessions")
    .select("id")
    .eq(identityColumn, canonicalIdentity.identity)
    .neq("purpose", "PAYMENT_RECOVERY");
  if (identityErr) {
    return {
      finalized: false,
      reason: `canonical_capture_identity_lookup_failed:${identityErr.message}`,
      audit: {
        session_id: sessionId,
        trip_id: context.tripId,
        identity_column: identityColumn,
        identity_value: canonicalIdentity.identity,
        error_message: identityErr.message,
      },
    };
  }
  if (!Array.isArray(identityMatches) || identityMatches.length !== 1) {
    return {
      finalized: false,
      reason: `duplicate_or_missing_canonical_capture_identity:${identityColumn}`,
      audit: {
        session_id: sessionId,
        trip_id: context.tripId,
        identity_column: identityColumn,
        identity_value: canonicalIdentity.identity,
        matched_rows: Array.isArray(identityMatches) ? identityMatches.length : 0,
      },
    };
  }

  const now = new Date().toISOString();

  // Strict compare-and-set: update only if status is EXACTLY the current observed value
  // AND still not "captured". This prevents double-finalization in concurrent requests.
  const { error } = await supabase
    .from("payment_sessions")
    .update({
      status: "captured",
      financial_operation_state: "CAPTURED",
      financial_operation_owner: null,
      financial_operation_started_at: null,
      updated_at: now,
      metadata: {
        ...(typeof session.metadata === "object" && session.metadata !== null
          ? (session.metadata as Record<string, unknown>)
          : {}),
        lifecycle_finalized_at: now,
        lifecycle_finalized_by: context.source,
        lifecycle_finalized_from_status: currentStatus,
        lifecycle_finalized_trip_id: context.tripId,
      },
    })
    .eq("id", sessionId)
    .eq("status", currentStatus) // compare-and-set: exact current status
    .eq("financial_operation_state", currentFinancialOperationState)
    .neq("status", "captured"); // never overwrite an already-captured row

  if (error) {
    const audit = {
      session_id: sessionId,
      trip_id: context.tripId,
      source: context.source,
      error_message: error.message,
      error_code: (error as unknown as Record<string, unknown>).code ?? null,
    };
    console.error("[paymentSessionLifecycleFinalizer] DB update failed", audit);
    return { finalized: false, reason: `db_update_failed:${error.message}`, audit };
  }

  console.log("[paymentSessionLifecycleFinalizer] lifecycle mismatch finalized", {
    session_id: sessionId,
    trip_id: context.tripId,
    from_status: currentStatus,
    to_status: "captured",
    source: context.source,
  });

  return { finalized: true, sessionId };
}
