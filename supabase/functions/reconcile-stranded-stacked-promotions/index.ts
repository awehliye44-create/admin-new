/**
 * #54D — Cron/service-role recovery for stranded stacked promotions.
 * Bounded, idempotent. Does not capture payments or invent dispatch rules.
 */
import { createServiceRoleClient, serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import { runStackedPromotionReconcilePass } from "./lib/stackedPromotionReconcileSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
  "Content-Type": "application/json",
};

serveWithEdgeTiming("reconcile-stranded-stacked-promotions", corsHeaders, async (req) => {
  const cronAuth = await assertCronOrServiceRoleAuth(req);
  if (!cronAuth.ok) return cronAuth.response;

  const supabase = createServiceRoleClient();
  const counts = await runStackedPromotionReconcilePass(supabase);

  return new Response(JSON.stringify({ ok: true, ...counts }), {
    status: 200,
    headers: corsHeaders,
  });
});
