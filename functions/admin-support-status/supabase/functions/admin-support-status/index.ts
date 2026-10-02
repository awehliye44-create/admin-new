/**
 * admin-support-status
 *
 * Public (anon-key) endpoint polled by the onecab.net website every 60 seconds
 * to decide whether to show the customer-facing support chat widget.
 *
 * Returns { available: true } when an admin heartbeat was received within the
 * last 2 minutes, { available: false } otherwise.
 *
 * Auth: none required — called with anon key from the public website.
 * Method: GET or POST (body ignored).
 * Cache: response includes Cache-Control: max-age=30 to reduce edge invocations.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30, stale-while-revalidate=30",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { data, error } = await serviceClient
    .from("admin_support_availability")
    .select("last_heartbeat_at")
    .eq("id", "singleton")
    .maybeSingle();

  if (error) {
    console.error("[admin-support-status] query error:", error.message);
    // Fail closed — never advertise support when availability is unknown.
    return json({ available: false, error: "status_check_failed" });
  }

  if (!data) {
    return json({ available: false });
  }

  const ageMs = Date.now() - new Date(data.last_heartbeat_at).getTime();
  const available = ageMs < STALE_THRESHOLD_MS;

  return json({ available, heartbeat_age_ms: ageMs });
});
