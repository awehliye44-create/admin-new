/**
 * Capture decision after retrieve — idempotent same-order capture.
 * Complements same-order increment; never creates a second order.
 */

import type { RevolutOrder } from "./revolutOrders.ts";
import { revolutProviderAuthorisedTotalPence } from "./revolutOrders.ts";
import { buildCaptureBusinessKey } from "./revolutIncrementAuthorisationSSOT.ts";

export type CaptureAfterRetrieveDecision =
  | {
    action: "reconcile_already_captured";
    captureAmountPence: number;
    providerState: string;
    businessKey: string;
  }
  | {
    action: "wait_processing";
    captureAmountPence: number;
    providerState: string;
    businessKey: string;
  }
  | {
    action: "retry_capture";
    captureAmountPence: number;
    providerState: string;
    businessKey: string;
    providerAuthorisedPence: number;
  }
  | {
    action: "shortfall_unusable";
    captureAmountPence: number;
    providerState: string;
    businessKey: string;
    remainingShortfallPence: number;
  }
  | {
    action: "blocked_above_authorised";
    captureAmountPence: number;
    providerState: string;
    businessKey: string;
    providerAuthorisedPence: number;
  };

/**
 * Decide capture behaviour from a freshly retrieved Revolut order.
 * captureAmountPence must be the frozen final fare (never invented here).
 */
export function decideCaptureAfterRetrieve(args: {
  paymentSessionId: string;
  providerOrderId: string;
  order: RevolutOrder;
  finalFarePence: number;
}): CaptureAfterRetrieveDecision {
  const finalFare = Math.max(0, Math.round(Number(args.finalFarePence)));
  const businessKey = buildCaptureBusinessKey({
    paymentSessionId: args.paymentSessionId,
    providerOrderId: args.providerOrderId,
    finalFarePence: finalFare,
  });
  const state = String(args.order.state ?? "").toUpperCase();
  const authorised = revolutProviderAuthorisedTotalPence(args.order);

  if (state === "COMPLETED" || state === "CAPTURED") {
    const captured = authorised > 0 ? authorised : finalFare;
    return {
      action: "reconcile_already_captured",
      captureAmountPence: captured,
      providerState: state,
      businessKey,
    };
  }

  if (state === "PROCESSING" || state === "PENDING") {
    return {
      action: "wait_processing",
      captureAmountPence: finalFare,
      providerState: state,
      businessKey,
    };
  }

  if (state === "AUTHORISED" || state === "AUTHORIZED") {
    if (finalFare > authorised && authorised > 0) {
      return {
        action: "blocked_above_authorised",
        captureAmountPence: Math.min(finalFare, authorised),
        providerState: state,
        businessKey,
        providerAuthorisedPence: authorised,
      };
    }
    return {
      action: "retry_capture",
      captureAmountPence: finalFare,
      providerState: state,
      businessKey,
      providerAuthorisedPence: authorised,
    };
  }

  return {
    action: "shortfall_unusable",
    captureAmountPence: 0,
    providerState: state || "UNKNOWN",
    businessKey,
    remainingShortfallPence: finalFare,
  };
}
