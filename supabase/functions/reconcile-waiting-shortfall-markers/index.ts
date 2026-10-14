/**
 * Scheduled recovery for waiting-time shortfalls whose receivable was not saved.
 *
 * Reads the durable payment-session marker (or the ops alert written when that
 * marker could not be committed) and calls the idempotent receivable/exception
 * path. Does not capture, does not increment, and does not create a second
 * debt when one already exists.
 */
import { createServiceRoleClient, serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import { runWaitingShortfallRecovery, type AlertClient } from "./recoveryJob.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
  "Content-Type": "application/json",
};

serveWithEdgeTiming("reconcile-waiting-shortfall-markers", corsHeaders, async (req) => {
  const cronAuth = await assertCronOrServiceRoleAuth(req);
  if (!cronAuth.ok) return cronAuth.response;

  const result = await runWaitingShortfallRecovery(createServiceRoleClient() as unknown as AlertClient);
  return new Response(JSON.stringify(result.body), {
    status: result.httpStatus,
    headers: corsHeaders,
  });
});
