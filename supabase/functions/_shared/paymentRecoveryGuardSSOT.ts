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

/** Safe capture when increment declined: min(final, authorised). */
export function safeCaptureAfterIncrementDecline(args: {
  finalFarePence: number;
  providerConfirmedAuthorisedTotalPence: number;
}): { capturePence: number; shortfallPence: number; payablePence: number } {
  const finalFare = Math.max(0, Math.round(Number(args.finalFarePence)));
  const auth = Math.max(
    0,
    Math.round(Number(args.providerConfirmedAuthorisedTotalPence)),
  );
  const capturePence = Math.min(finalFare, auth);
  return {
    capturePence,
    shortfallPence: Math.max(0, finalFare - capturePence),
    // Guard against a changed fare, not the deliberately smaller funded capture.
    payablePence: finalFare,
  };
}
