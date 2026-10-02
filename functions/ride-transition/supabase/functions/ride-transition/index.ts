/**
 * RETIRED — all trip lifecycle mutations use stop-workflow.
 * Driver cancel: stop-workflow action driver_cancel | cancel_queued_stacked
 * Pre-pickup rematch: driver-cancel-before-pickup
 */

import { handleCORSPreflight } from "../_shared/security.ts";
import { legacyEdgeBlockedResponse } from "../_shared/legacyEdgeGuard.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();
  return legacyEdgeBlockedResponse("ride-transition", "stop-workflow");
});
