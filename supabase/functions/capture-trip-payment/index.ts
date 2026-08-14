/**
 * RETIRED — card capture SSOT is finalize-trip-and-capture (onecab-comfy-ride).
 * DB reconciliation: payment-reconcile (read-only MARK_CAPTURED).
 */

import { handleCORSPreflight } from "../_shared/security.ts";
import { legacyEdgeBlockedResponse } from "../_shared/legacyEdgeGuard.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();
  return legacyEdgeBlockedResponse("capture-trip-payment", "finalize-trip-and-capture");
});
