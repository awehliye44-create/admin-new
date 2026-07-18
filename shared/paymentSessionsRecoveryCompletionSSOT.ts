/**
 * Recovery / payment-link capture completion SSOT.
 * Pure planning + idempotent patch builders — no DB I/O.
 * After recovery capture: update originals, close outstanding, never double-credit wallet.
 */

import {
  buildTripPaymentProjectionAfterCapture,
  computeOutstandingBalancePence,
  PAYMENT_LINK_STATE,
  recoveryWalletCreditDecision,
  resolveCanonicalCustomerPayablePence,
} from "./paymentSessionsCaptureConfirmationSSOT.ts";
import { confirmedPositiveCapturePence } from "./paymentCaptureEvidenceSSOT.ts";

export type RecoveryCaptureCompletionPlan = {
  recovery_session_patch: Record<string, unknown>;
  parent_session_patch: Record<string, unknown> | null;
  trip_patch: Record<string, unknown>;
  wallet: ReturnType<typeof recoveryWalletCreditDecision>;
  outstanding_pence: number;
  total_captured_pence: number;
  prevent_further_payment_links: boolean;
  /** Never overwrite trips.provider_order_id with the recovery order id. */
  preserve_original_provider_order_id: true;
};

export function planRecoveryCaptureCompletion(args: {
  recoveryCapturedPence: number;
  recoverySessionId: string;
  recoveryProviderOrderId: string;
  parentSessionId?: string | null;
  parentProviderOrderId?: string | null;
  parentMetadata?: Record<string, unknown> | null;
  recoveryMetadata?: Record<string, unknown> | null;
  originalCapturedPence?: number | null;
  priorRecoveryCapturedPence?: number | null;
  finalCustomerFarePence?: number | null;
  finalFarePence?: number | null;
  noShowChargePence?: number | null;
  cancellationFeePence?: number | null;
  estimatedTotalPence?: number | null;
  totalAuthorisedPence?: number | null;
  paymentProvider?: string | null;
  paymentMethod?: string | null;
  originalDriverEarningAlreadyCredited?: boolean;
  driverEarningWithheldPendingRecovery?: boolean;
  nowIso?: string;
}): RecoveryCaptureCompletionPlan {
  const now = args.nowIso ?? new Date().toISOString();
  const recoveryAmt = confirmedPositiveCapturePence(args.recoveryCapturedPence) ?? 0;
  const originalAmt = Math.max(0, confirmedPositiveCapturePence(args.originalCapturedPence) ?? 0);
  // When this recovery is the completing capture, prior recovery may already be counted;
  // total = original + this recovery (idempotent if same amount reapplied).
  const priorRecovery = Math.max(
    0,
    confirmedPositiveCapturePence(args.priorRecoveryCapturedPence) ?? 0,
  );
  const totalCaptured = originalAmt + Math.max(recoveryAmt, priorRecovery);

  const payable = resolveCanonicalCustomerPayablePence({
    finalCustomerFarePence: args.finalCustomerFarePence,
    finalFarePence: args.finalFarePence,
    noShowChargePence: args.noShowChargePence,
    cancellationFeePence: args.cancellationFeePence,
    estimatedTotalPence: args.estimatedTotalPence,
  });

  const outstanding = computeOutstandingBalancePence({
    canonicalPayablePence: payable.payable_pence,
    confirmedCapturePence: originalAmt,
    confirmedRecoveryCapturePence: Math.max(recoveryAmt, priorRecovery),
  }) ?? 0;

  const tripProjection = buildTripPaymentProjectionAfterCapture({
    canonicalPayablePence: payable.payable_pence,
    totalAuthorisedPence: args.totalAuthorisedPence,
    totalCapturedPence: totalCaptured,
    paymentProvider: args.paymentProvider ?? "revolut",
    paymentMethod: args.paymentMethod ?? null,
  });

  const recoveryMeta = {
    ...(args.recoveryMetadata && typeof args.recoveryMetadata === "object"
      ? args.recoveryMetadata
      : {}),
    payment_link_state: PAYMENT_LINK_STATE.CAPTURED,
    recovery_completed_at: now,
    recovery_captured_amount_pence: recoveryAmt,
    outstanding_closed: outstanding <= 0,
  };

  const recovery_session_patch: Record<string, unknown> = {
    status: "RECOVERY_COMPLETED",
    captured_amount_pence: recoveryAmt,
    captured_at: now,
    provider_state: "COMPLETED",
    provider_state_verified_at: now,
    provider_state_verified_by: "recovery_capture_webhook",
    metadata: recoveryMeta,
    updated_at: now,
  };

  let parent_session_patch: Record<string, unknown> | null = null;
  if (args.parentSessionId) {
    const parentMeta = {
      ...(args.parentMetadata && typeof args.parentMetadata === "object"
        ? args.parentMetadata
        : {}),
      recovery_completed: true,
      recovery_completed_at: now,
      recovery_session_id: args.recoverySessionId,
      recovery_provider_order_id: args.recoveryProviderOrderId,
      original_provider_order_id: args.parentProviderOrderId ?? null,
      total_confirmed_captured_pence: totalCaptured,
      outstanding_balance_pence: outstanding,
      payment_link_state: outstanding <= 0 ? PAYMENT_LINK_STATE.CAPTURED : undefined,
    };
    parent_session_patch = {
      recovery_required: outstanding > 0,
      metadata: parentMeta,
      updated_at: now,
    };
  }

  const wallet = recoveryWalletCreditDecision({
    originalDriverEarningAlreadyCredited: args.originalDriverEarningAlreadyCredited === true,
    recoveryCaptureConfirmed: recoveryAmt > 0,
    driverEarningWithheldPendingRecovery: args.driverEarningWithheldPendingRecovery === true,
  });

  return {
    recovery_session_patch,
    parent_session_patch,
    trip_patch: {
      payment_status: tripProjection.payment_status,
      payment_hold_status: "captured",
      capture_amount_pence: tripProjection.capture_amount_pence,
      outstanding_balance_pence: tripProjection.outstanding_balance_pence,
      payment_coverage_status: tripProjection.payment_coverage_status,
      // Explicitly omit provider_order_id — must preserve original booking order.
      updated_at: now,
    },
    wallet,
    outstanding_pence: outstanding,
    total_captured_pence: totalCaptured,
    prevent_further_payment_links: outstanding <= 0,
    preserve_original_provider_order_id: true,
  };
}

/** Idempotent: second identical recovery completion yields same outstanding 0. */
export function isRecoveryCompletionIdempotent(args: {
  priorRecoveryStatus?: string | null;
  priorRecoveryCapturedPence?: number | null;
  newRecoveryCapturedPence: number;
}): boolean {
  const status = String(args.priorRecoveryStatus ?? "").toUpperCase();
  if (status === "RECOVERY_COMPLETED" || status === "CAPTURED") {
    const prior = confirmedPositiveCapturePence(args.priorRecoveryCapturedPence);
    const next = confirmedPositiveCapturePence(args.newRecoveryCapturedPence);
    return prior != null && next != null && prior === next;
  }
  return false;
}
