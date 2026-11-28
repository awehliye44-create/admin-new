/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Terminal trip payment disposition SSOT.
 *
 * Open authorisations may remain only while a trip is dispatchable, rematching
 * (searching_new_driver), assigned before Start Trip, or in progress under the
 * approved capture lifecycle.
 *
 * Fee decision owner: terminalFeeDecisionSSOT.resolveTerminalPaymentDecision
 * Completed-trip settlement is never routed through this module.
 *
 * For terminal non-completed outcomes:
 *   - fee = 0  → void/cancel full Revolut authorisation
 *   - fee > 0  → partial capture fee only (Revolut releases remainder)
 *
 * Rematch / active / completed: do not void here.
 * Start Trip without completion: skip (interrupted-trip policy not invented here).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

import {
  cancelRevolutOrder,
  captureRevolutOrder,
  retrieveRevolutOrder,
  getRevolutMerchantConfig,
  mapRevolutStateToPaymentStatus,
} from "../../../functions/_shared/revolutOrders.ts";

import { guardedCaptureRevolutOrder } from "../../../functions/_shared/guardedProviderCaptureSSOT.ts";

import {
  assertHoldReleaseAllowed,
  stampReleaseTrigger,
  type HoldReleaseTrigger,
} from "../../../functions/_shared/paymentHoldGuard.ts";

import { resolveTripPaymentProvider, tripProviderOrderId } from "../../../functions/_shared/tripPaymentProviderSSOT.ts";

import {
  resolveTerminalPaymentDecision,
  shouldApplyForceFeeOverride,
  type FarePricingFeeConfig,
  type TerminalPaymentDecision,
} from "../../../functions/_shared/terminalFeeDecisionSSOT.ts";

import {
  claimPaymentSessionFinancialLock,
  releasePaymentSessionFinancialLock,
} from "../../../functions/_shared/paymentSessionFinancialLockSSOT.ts";

import { shouldBlockPrematureScheduledSearchHoldRelease } from "../../../functions/_shared/scheduledHandoverHoldLock.ts";

import { assertFareCaptureAllowedAtProvider } from "../../../functions/_shared/scheduledFareCaptureGateSSOT.ts";

import { transitionPaymentSession } from "../../../functions/_shared/paymentSessionTransitionFacade.ts";

import { reconcileReceivablesOnAbandonOrCancel } from "../../../functions/_shared/customerReceivableLifecycle.ts";

import {
  resolveCanonicalWaitingSeconds,
  WAITING_EVIDENCE_UNAVAILABLE,
} from "../../../functions/_shared/waitingSegmentClock.ts";


export function sessionMetadataContradictsCapture(
  metadata: Record<string, unknown> | null | undefined,
  capturedFeePence: number,
): boolean {
  if (capturedFeePence <= 0) return false;
  const meta = metadata ?? {};
  if (meta.terminal_disposition_pending === true || meta.pending === true) return true;
  if (meta.void_full === true) return true;
  if (meta.terminal_disposition_provider_action === "void_full") return true;
  if (Number(meta.terminal_disposition_fee_pence ?? meta.fee_pence ?? 0) === 0) return true;
  const decision = meta.terminal_disposition_decision;
  if (decision && typeof decision === "object") {
    const row = decision as Record<string, unknown>;
    if (row.provider_action === "void_full") return true;
    if (Number(row.fee_amount_pence ?? row.capture_required_pence ?? 0) === 0) return true;
  }
  return false;
}

export * from "../../../functions/_shared/terminalTripPaymentDisposition.ts";
