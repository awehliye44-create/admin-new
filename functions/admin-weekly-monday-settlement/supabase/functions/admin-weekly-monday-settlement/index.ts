/**
 * DEPRECATED entry point — renamed conceptually from WEEKLY_MONDAY.
 * Preserves the old URL for residual callers; forwards to Slice 5 scheduler semantics
 * by importing the same SSOT and instructing clients to use admin-weekly-payout-scheduler.
 *
 * Production cron now invokes admin-weekly-payout-scheduler directly.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Soft-forward: re-issue the request shape to the canonical scheduler via self-invoke
  // is not available from Deno edge without HTTP. Return explicit redirect payload so
  // callers/UI switch; cron already points at admin-weekly-payout-scheduler.
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({
      success: false,
      error: "missing_supabase_env",
      deprecated: true,
      use_instead: "admin-weekly-payout-scheduler",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const forwardUrl = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/admin-weekly-payout-scheduler`;
  const auth = req.headers.get("Authorization") ?? `Bearer ${serviceKey}`;
  const cronSecret = req.headers.get("x-onecab-cron-secret");

  const forwardBody = {
    ...body,
    // Never write WEEKLY_MONDAY from this shim — canonical scheduler uses WEEKLY_SCHEDULED.
    forwarded_from: "admin-weekly-monday-settlement",
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: auth,
    apikey: serviceKey,
  };
  if (cronSecret) headers["x-onecab-cron-secret"] = cronSecret;

  const res = await fetch(forwardUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(forwardBody),
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
