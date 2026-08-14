/**
 * RETIRED — driver accept uses accept-offer → accept_ride_offer (driver_assigned).
 * All overlay Accept buttons route through runAcceptTrip → invokeAcceptOffer.
 */

import { handleCORSPreflight } from "../_shared/security.ts";
import { legacyEdgeBlockedResponse } from "../_shared/legacyEdgeGuard.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();
  return legacyEdgeBlockedResponse("create-active-trip", "accept-offer");
});
