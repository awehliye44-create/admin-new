/**
 * Recovery / shortfall guards — closes MK-260805-016 class failures.
 *
 * Infrastructure failure (e.g. finalize 503) is NOT proof the Revolut capture failed.
 * Before creating any recovery order, retrieve the parent provider order.
 */

import type { RevolutOrder } from "./revolutOrders.ts";
import { revolutProviderAuthorisedTotalPence } from "./revolutOrders.ts";

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
