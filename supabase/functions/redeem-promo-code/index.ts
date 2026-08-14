import { handleCORSPreflight } from "../_shared/security.ts";
import { legacyEdgeBlockedResponse } from "../_shared/legacyEdgeGuard.ts";

/** RETIRED — promos applied server-side in create-ride / get-active-offer */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();
  return legacyEdgeBlockedResponse("redeem-promo-code", "create-ride");
});
