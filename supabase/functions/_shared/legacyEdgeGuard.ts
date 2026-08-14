/**
 * Hard-block legacy / ghost edge functions from production mutation paths.
 */

import { errorResponse } from "./security.ts";

export const BLOCKED_LEGACY_EDGE_FUNCTIONS = [
  "capture-trip-payment",
  "ride-transition",
  "process-scheduled-rides",
  "customer-decision",
  "driver-send-preset-offer",
  "mapbox-search",
  "change-active-trip-payment-method",
  "redeem-promo-code",
  "get-vapid-key",
  "save-push-subscription",
  "start-waiting-charge",
  "complete-stop",
  "complete-trip",
  "update-trip-status",
] as const;

export function legacyEdgeBlockedResponse(
  edgeName: string,
  replacement: string,
): Response {
  console.warn(`[${edgeName}] LEGACY_EDGE_BLOCKED — use ${replacement}`);
  return errorResponse(
    "LEGACY_EDGE_BLOCKED",
    `${edgeName} is retired. Use ${replacement}.`,
    410,
    { replacement, edge: edgeName },
  );
}
