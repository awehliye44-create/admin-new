/**
 * Process durable trip_capture_jobs created by stop-workflow complete_trip.
 * Uses the existing finalize-trip-and-capture invoke (idempotent).
 * Also retries durable admin alerts for failed_terminal rows still pending.
 * Auth: cron secret or service role only.
 *
 * Body (optional): { trip_id?: string, limit?: number, dry_run?: boolean }
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import {
  claimTripCaptureJobs,
  processClaimedTripCaptureJob,
  processPendingTripCaptureAdminAlerts,
  processTripCaptureJobByTripId,
} from "../_shared/tripCaptureJobSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      /* empty ok */
    }

    const auth = await assertCronOrServiceRoleAuth(req, body);
    if (!auth.ok) return auth.response;

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(
        JSON.stringify({ success: false, error: "missing_supabase_env" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const dryRun = body.dry_run === true;
    const tripId = typeof body.trip_id === "string" ? body.trip_id.trim() : "";
    const limit = Math.min(50, Math.max(1, Number(body.limit ?? 20) || 20));

    if (dryRun) {
      return new Response(
        JSON.stringify({ success: true, dry_run: true, trip_id: tripId || null, limit }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const results: Array<{ trip_id: string; outcome: string }> = [];

    if (tripId) {
      const one = await processTripCaptureJobByTripId(supabase, tripId, {
        supabaseUrl,
        serviceRoleKey,
      });
      results.push({ trip_id: tripId, outcome: one.outcome });
    } else {
      const claimed = await claimTripCaptureJobs(supabase, { limit });
      for (const job of claimed) {
        const one = await processClaimedTripCaptureJob(supabase, job, {
          supabaseUrl,
          serviceRoleKey,
        });
        results.push({ trip_id: job.tripId, outcome: one.outcome });
      }
    }

    // Retry durable admin alerts independently of capture claims.
    const alertResults = await processPendingTripCaptureAdminAlerts(supabase, limit);

    return new Response(
      JSON.stringify({
        success: true,
        processed: results.length,
        results,
        alert_retries: alertResults,
        auth: auth.source,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[process-trip-capture-jobs] fatal", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
