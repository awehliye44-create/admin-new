/**
 * admin-support-heartbeat
 *
 * Called by the admin app every 30 seconds while an authorised admin is signed in.
 * Upserts a single "singleton" row in admin_support_availability with the current
 * timestamp, so the public admin-support-status endpoint can report availability.
 *
 * Auth: requires a valid admin Supabase JWT (has_role = 'admin').
 * Method: POST (body ignored).
 * Response: { ok: true } or { ok: false, error: string } — always HTTP 200 so
 * Cursor/Lovable preview never treats expected auth gaps as blank-screen RUNTIME_ERROR.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ ok: false, error: "Authorization required" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  // Verify the caller is an authenticated admin using their JWT.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: authErr } = await callerClient.auth.getUser();
  if (authErr || !user) return json({ ok: false, error: "Unauthorized" });

  // Verify the user has the 'admin' app_role.
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  const { data: roleRow } = await serviceClient
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .maybeSingle();

  if (!roleRow) return json({ ok: false, error: "Forbidden" });

  // Upsert the singleton availability heartbeat.
  const { error: upsertErr } = await serviceClient
    .from("admin_support_availability")
    .upsert(
      { id: "singleton", last_heartbeat_at: new Date().toISOString(), admin_user_id: user.id, updated_at: new Date().toISOString() },
      { onConflict: "id" },
    );

  if (upsertErr) {
    console.error("[admin-support-heartbeat] upsert error:", upsertErr.message);
    return json({ ok: false, error: "Failed to update availability" });
  }

  return json({ ok: true });
});
