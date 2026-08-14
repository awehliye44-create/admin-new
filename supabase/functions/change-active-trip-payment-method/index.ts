import { handleCORSPreflight } from "../_shared/security.ts";
import { legacyEdgeBlockedResponse } from "../_shared/legacyEdgeGuard.ts";

/** RETIRED — use switch-trip-payment-method */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();
  return legacyEdgeBlockedResponse("change-active-trip-payment-method", "switch-trip-payment-method");
});
