/**
 * Apply monotonic Payment Session lifecycle updates from Revolut webhooks.
 * Uses strict compare-and-set on status (+ financial_operation_state when present).
 *
 * Never posts wallet money, settlement stamps, or provider capture/refund calls.
 *
 * Lock: paymentSessionWebhookLifecycleLock.test.ts
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  resolvePaymentSessionStatusFromProviderWebhook,
  type PaymentSessionWebhookLifecycleDecision,
  type ResolvePaymentSessionStatusFromProviderWebhookResult,
} from "./paymentSessionWebhookLifecycleResolver.ts";

export type PaymentSessionWebhookLifecycleContext = {
  sessionId: string;
  tripId?: string | null;
  providerOrderId?: string | null;
  providerCaptureId?: string | null;
  currentStatus: string;
  financialOperationState?: string | null;
  financialModel?: string | null;
  purpose?: string | null;
  storedCapturedAmountPence?: number | null;
  refundedAmountPence?: number | null;
  holdReleaseState?: string | null;
  storedProviderCaptureId?: string | null;
  storedProviderOrderId?: string | null;
  priorProviderState?: string | null;
};

export type PaymentSessionWebhookLifecycleUpdateResult = {
  applied: boolean;
  decision: PaymentSessionWebhookLifecycleDecision;
  session_id: string;
  trip_id: string | null;
  provider_order_id: string | null;
  provider_capture_id: string | null;
  previous_status: string;
  attempted_status: string | null;
  provider_state: string;
  reason: string;
  error_code?: string;
  error_message?: string;
  lifecycle_conflict?: boolean;
  reloaded?: boolean;
};

export type ApplyPaymentSessionWebhookLifecycleUpdateArgs = {
  supabase: SupabaseClient;
  context: PaymentSessionWebhookLifecycleContext;
  providerState: string;
  /** Incoming captured amount from webhook payload (minor units). */
  incomingCapturedAmountPence?: number | null;
  /** Provider evidence fields safe to persist regardless of status decision. */
  providerEvidencePatch: Record<string, unknown>;
  /** Extra fields when status ADVANCE (e.g. authorised amounts, captured_at). */
  statusAdvanceExtras?: Record<string, unknown>;
  /** When true, skip DB write (resolver-only / dry-run). */
  dryRun?: boolean;
};

function buildStructuredResult(
  base: PaymentSessionWebhookLifecycleContext,
  providerState: string,
  resolution: ResolvePaymentSessionStatusFromProviderWebhookResult,
  applied: boolean,
  extra?: Partial<PaymentSessionWebhookLifecycleUpdateResult>,
): PaymentSessionWebhookLifecycleUpdateResult {
  return {
    applied,
    decision: resolution.decision,
    session_id: base.sessionId,
    trip_id: base.tripId ?? null,
    provider_order_id: base.providerOrderId ?? base.storedProviderOrderId ?? null,
    provider_capture_id: base.providerCaptureId ?? base.storedProviderCaptureId ?? null,
    previous_status: base.currentStatus,
    attempted_status: resolution.nextStatus ?? null,
    provider_state: providerState,
    reason: resolution.reason,
    ...extra,
  };
}

async function reloadSession(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .from("payment_sessions")
    .select(
      "id, trip_id, status, financial_operation_state, financial_model, purpose, captured_amount_pence, refunded_amount_pence, hold_release_state, provider_capture_id, provider_order_id, provider_state",
    )
    .eq("id", sessionId)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

async function attemptCasUpdate(
  supabase: SupabaseClient,
  args: ApplyPaymentSessionWebhookLifecycleUpdateArgs,
  resolution: ResolvePaymentSessionStatusFromProviderWebhookResult,
): Promise<{ applied: boolean; error?: { message: string; code?: string } }> {
  const patch: Record<string, unknown> = {
    ...args.providerEvidencePatch,
    updated_at: new Date().toISOString(),
  };

  if (resolution.decision === "ADVANCE" && resolution.nextStatus) {
    Object.assign(patch, args.statusAdvanceExtras ?? {});
    patch.status = resolution.nextStatus;
  }

  let query = supabase
    .from("payment_sessions")
    .update(patch)
    .eq("id", args.context.sessionId)
    .eq("status", args.context.currentStatus);

  const opState = String(args.context.financialOperationState ?? "").trim();
  if (opState) {
    query = query.eq("financial_operation_state", opState);
  }

  const { error } = await query;
  if (error) {
    return { applied: false, error: { message: error.message, code: error.code } };
  }
  return { applied: true };
}

/**
 * Resolve lifecycle decision and apply compare-and-set update when appropriate.
 * On CAS miss, reloads once and preserves newer valid state.
 */
export async function applyPaymentSessionWebhookLifecycleUpdate(
  args: ApplyPaymentSessionWebhookLifecycleUpdateArgs,
): Promise<PaymentSessionWebhookLifecycleUpdateResult> {
  const providerState = String(args.providerState ?? "").toUpperCase();
  const resolution = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: args.context.currentStatus,
    providerState,
    tripId: args.context.tripId,
    capturedAmountPence: args.incomingCapturedAmountPence,
    storedCapturedAmountPence: args.context.storedCapturedAmountPence,
    refundedAmountPence: args.context.refundedAmountPence,
    holdReleaseState: args.context.holdReleaseState,
    financialOperationState: args.context.financialOperationState,
    financialModel: args.context.financialModel,
    purpose: args.context.purpose,
    incomingProviderCaptureId: args.context.providerCaptureId,
    storedProviderCaptureId: args.context.storedProviderCaptureId,
    storedProviderOrderId: args.context.storedProviderOrderId ?? args.context.providerOrderId,
    incomingProviderOrderId: args.context.providerOrderId,
    priorProviderState: args.context.priorProviderState,
  });

  if (resolution.decision === "LIFECYCLE_CONFLICT") {
    return buildStructuredResult(args.context, providerState, resolution, false, {
      lifecycle_conflict: true,
    });
  }

  if (args.dryRun) {
    return buildStructuredResult(args.context, providerState, resolution, false);
  }

  // PENDING_EVIDENCE / KEEP_CURRENT — persist provider evidence only (no status change).
  if (resolution.decision !== "ADVANCE") {
    const evidenceOnly = {
      ...args.providerEvidencePatch,
      updated_at: new Date().toISOString(),
    };
    const { error } = await args.supabase
      .from("payment_sessions")
      .update(evidenceOnly)
      .eq("id", args.context.sessionId);
    if (error) {
      return buildStructuredResult(args.context, providerState, resolution, false, {
        error_code: error.code,
        error_message: error.message,
      });
    }
    return buildStructuredResult(args.context, providerState, resolution, true);
  }

  const first = await attemptCasUpdate(args.supabase, args, resolution);
  if (!first.error) {
    return buildStructuredResult(args.context, providerState, resolution, first.applied);
  }

  // CAS or update failed — reload once and re-resolve.
  const reloaded = await reloadSession(args.supabase, args.context.sessionId);
  if (!reloaded) {
    return buildStructuredResult(args.context, providerState, resolution, false, {
      error_code: first.error.code,
      error_message: first.error.message,
      reloaded: true,
    });
  }

  const reloadedContext: PaymentSessionWebhookLifecycleContext = {
    ...args.context,
    currentStatus: String(reloaded.status ?? args.context.currentStatus),
    financialOperationState: reloaded.financial_operation_state as string | null,
    storedCapturedAmountPence: reloaded.captured_amount_pence as number | null,
  };

  const reResolution = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: reloadedContext.currentStatus,
    providerState,
    tripId: reloadedContext.tripId ?? (reloaded.trip_id as string | null),
    capturedAmountPence: args.incomingCapturedAmountPence,
    storedCapturedAmountPence: reloadedContext.storedCapturedAmountPence,
    refundedAmountPence: reloaded.refunded_amount_pence as number | null,
    holdReleaseState: reloaded.hold_release_state as string | null,
    financialOperationState: reloadedContext.financialOperationState,
    financialModel: reloadedContext.financialModel,
    purpose: reloadedContext.purpose,
    storedProviderCaptureId: reloaded.provider_capture_id as string | null,
    storedProviderOrderId: reloaded.provider_order_id as string | null,
    incomingProviderOrderId: args.context.providerOrderId,
    priorProviderState: reloaded.provider_state as string | null,
  });

  if (reResolution.decision === "KEEP_CURRENT" || reResolution.decision === "PENDING_EVIDENCE") {
    return buildStructuredResult(reloadedContext, providerState, reResolution, true, {
      reloaded: true,
      reason: `cas_miss_preserved_newer_state:${reResolution.reason}`,
    });
  }

  if (reResolution.decision === "LIFECYCLE_CONFLICT") {
    return buildStructuredResult(reloadedContext, providerState, reResolution, false, {
      reloaded: true,
      lifecycle_conflict: true,
      error_code: first.error.code,
      error_message: first.error.message,
    });
  }

  const retryArgs: ApplyPaymentSessionWebhookLifecycleUpdateArgs = {
    ...args,
    context: reloadedContext,
  };
  const second = await attemptCasUpdate(args.supabase, retryArgs, reResolution);
  if (second.error) {
    return buildStructuredResult(reloadedContext, providerState, reResolution, false, {
      reloaded: true,
      error_code: second.error.code,
      error_message: second.error.message,
      lifecycle_conflict: true,
    });
  }

  return buildStructuredResult(reloadedContext, providerState, reResolution, second.applied, {
    reloaded: true,
  });
}
