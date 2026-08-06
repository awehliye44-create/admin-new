/**
 * Recovery / shortfall guards — closes MK-260805-016 class failures.
 *
 * Infrastructure failure (e.g. finalize 503) is NOT proof the Revolut capture failed.
 * Before creating any recovery order, retrieve the parent provider order.
 */

import type { RevolutOrder } from "./revolutOrders.ts";
import { revolutProviderAuthorisedTotalPence } from "./revolutOrders.ts";

export type RecoveryGuardDecision =
  | {
    allowRecovery: false;
    reason:
      | "original_authorised_hold_usable"
      | "original_already_captured"
      | "original_processing"
      | "original_unknown_reconcile"
      | "remaining_shortfall_zero"
      | "operation_pending";
    action:
      | "retry_original_capture"
      | "reconcile_only"
      | "wait_reconcile"
      | "none";
    remainingShortfallPence: number;
    providerState: string | null;
    providerAuthorisedPence: number;
    message: string;
  }
  | {
    allowRecovery: true;
    reason: "original_unusable";
    remainingShortfallPence: number;
    providerState: string | null;
    providerAuthorisedPence: number;
    message: string;
  };

export function computeRemainingShortfallPence(args: {
  finalFarePence: number;
  confirmedOriginalCapturePence: number;
  confirmedRecoveryPaymentsPence?: number;
  confirmedRefundsPence?: number;
}): number {
  const finalFare = Math.max(0, Math.round(Number(args.finalFarePence)));
  const paid = Math.max(0, Math.round(Number(args.confirmedOriginalCapturePence)))
    + Math.max(0, Math.round(Number(args.confirmedRecoveryPaymentsPence ?? 0)))
    - Math.max(0, Math.round(Number(args.confirmedRefundsPence ?? 0)));
  return Math.max(0, finalFare - paid);
}

/**
 * Decide whether Admin/create-payment-recovery may open a second order.
 * Parent order must already have been retrieved from Revolut.
 */
export function decidePaymentRecoveryGuard(args: {
  parentOrder: RevolutOrder | null | undefined;
  finalFarePence: number;
  /** Local captured_amount_pence when provider does not yet show COMPLETED. */
  localCapturedPence?: number | null;
  confirmedRecoveryPaymentsPence?: number;
  confirmedRefundsPence?: number;
  financialOperationState?: string | null;
}): RecoveryGuardDecision {
  const op = String(args.financialOperationState ?? "IDLE").toUpperCase();
  if (
    op === "INCREMENTING"
    || op === "CAPTURING"
    || op === "RECONCILING"
    || op === "RECOVERY_PENDING"
  ) {
    return {
      allowRecovery: false,
      reason: "operation_pending",
      action: "wait_reconcile",
      remainingShortfallPence: 0,
      providerState: null,
      providerAuthorisedPence: 0,
      message:
        "A payment operation is already in progress. Wait for reconciliation before starting recovery.",
    };
  }

  const order = args.parentOrder;
  if (!order?.id) {
    return {
      allowRecovery: false,
      reason: "original_unknown_reconcile",
      action: "wait_reconcile",
      remainingShortfallPence: 0,
      providerState: null,
      providerAuthorisedPence: 0,
      message:
        "Parent Revolut order could not be retrieved. Reconcile before creating recovery.",
    };
  }

  const state = String(order.state ?? "").toUpperCase();
  const authorised = revolutProviderAuthorisedTotalPence(order);
  const localCaptured = Math.max(0, Math.round(Number(args.localCapturedPence ?? 0)));

  const remainingAfterPaid = (captured: number) =>
    computeRemainingShortfallPence({
      finalFarePence: args.finalFarePence,
      confirmedOriginalCapturePence: captured,
      confirmedRecoveryPaymentsPence: args.confirmedRecoveryPaymentsPence,
      confirmedRefundsPence: args.confirmedRefundsPence,
    });

  if (state === "COMPLETED" || state === "CAPTURED") {
    const captured = authorised > 0 ? authorised : localCaptured;
    const remaining = remainingAfterPaid(captured);
    if (remaining <= 0) {
      return {
        allowRecovery: false,
        reason: "remaining_shortfall_zero",
        action: "reconcile_only",
        remainingShortfallPence: 0,
        providerState: state,
        providerAuthorisedPence: authorised,
        message: "Original order is already captured and the final fare is fully paid.",
      };
    }
    // Partial capture — recovery only for the difference.
    return {
      allowRecovery: true,
      reason: "original_unusable",
      remainingShortfallPence: remaining,
      providerState: state,
      providerAuthorisedPence: authorised,
      message: `Original order captured; remaining shortfall is ${remaining} pence only.`,
    };
  }

  if (state === "PROCESSING" || state === "PENDING") {
    return {
      allowRecovery: false,
      reason: "original_processing",
      action: "wait_reconcile",
      remainingShortfallPence: remainingAfterPaid(localCaptured),
      providerState: state,
      providerAuthorisedPence: authorised,
      message: "Original order is still processing. Wait and reconcile — do not create recovery yet.",
    };
  }

  if (state === "AUTHORISED" || state === "AUTHORIZED") {
    return {
      allowRecovery: false,
      reason: "original_authorised_hold_usable",
      action: "retry_original_capture",
      remainingShortfallPence: remainingAfterPaid(0),
      providerState: state,
      providerAuthorisedPence: authorised,
      message:
        "Original authorised hold is still active. Retrieve and capture the original order before starting recovery.",
    };
  }

  if (
    state === "CANCELLED"
    || state === "CANCELED"
    || state === "FAILED"
    || state === "REFUNDED"
  ) {
    const remaining = remainingAfterPaid(localCaptured);
    if (remaining <= 0) {
      return {
        allowRecovery: false,
        reason: "remaining_shortfall_zero",
        action: "reconcile_only",
        remainingShortfallPence: 0,
        providerState: state,
        providerAuthorisedPence: authorised,
        message: "No remaining shortfall after provider state reconciliation.",
      };
    }
    return {
      allowRecovery: true,
      reason: "original_unusable",
      remainingShortfallPence: remaining,
      providerState: state,
      providerAuthorisedPence: authorised,
      message:
        `Original order is ${state} and unusable. Controlled recovery for remaining ${remaining} pence only.`,
    };
  }

  return {
    allowRecovery: false,
    reason: "original_unknown_reconcile",
    action: "wait_reconcile",
    remainingShortfallPence: remainingAfterPaid(localCaptured),
    providerState: state || null,
    providerAuthorisedPence: authorised,
    message:
      "Original order state is unknown. Retrieve and reconcile before creating recovery.",
  };
}

/** Safe capture when increment declined: min(final, authorised). */
export function safeCaptureAfterIncrementDecline(args: {
  finalFarePence: number;
  providerConfirmedAuthorisedTotalPence: number;
}): { capturePence: number; shortfallPence: number } {
  const finalFare = Math.max(0, Math.round(Number(args.finalFarePence)));
  const auth = Math.max(
    0,
    Math.round(Number(args.providerConfirmedAuthorisedTotalPence)),
  );
  const capturePence = Math.min(finalFare, auth);
  return {
    capturePence,
    shortfallPence: Math.max(0, finalFare - capturePence),
  };
}
