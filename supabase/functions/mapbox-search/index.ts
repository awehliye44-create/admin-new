import { handleCORSPreflight } from "../_shared/security.ts";
import { legacyEdgeBlockedResponse } from "../_shared/legacyEdgeGuard.ts";

/** RETIRED — use place-lookup */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();
  return legacyEdgeBlockedResponse("mapbox-search", "place-lookup");
});
