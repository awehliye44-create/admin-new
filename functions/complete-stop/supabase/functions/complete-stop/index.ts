/**
 * RETIRED — stop lifecycle SSOT is stop-workflow.
 * Legacy complete-stop must not mutate stops or trip state (MK-260916-030 hygiene).
 */
import { legacyEdgeBlockedResponse } from "../_shared/legacyEdgeGuard.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  return legacyEdgeBlockedResponse(
    "complete-stop",
    "stop-workflow (arrive_stop / drive_to_next / complete_trip)",
  );
});
