import { handleCORSPreflight } from "../_shared/security.ts";
import { legacyEdgeBlockedResponse } from "../_shared/legacyEdgeGuard.ts";

/** RETIRED — customer app uses Capacitor FCM + save-customer-push-token */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();
  return legacyEdgeBlockedResponse("get-vapid-key", "save-customer-push-token");
});
