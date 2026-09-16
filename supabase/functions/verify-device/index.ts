import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface VerifyDeviceRequest {
  device_id: string;
}

/**
 * verify-device
 * Called on app start / resume. Returns whether the supplied device_id is
 * still the active device for this user.
 *
 * Response: { active: boolean, server_device_id: string | null }
 *  - active=true  -> caller may continue.
 *  - active=false -> caller MUST sign out and show the "signed in elsewhere"
 *                    message.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);
    const jwt = authHeader.replace("Bearer ", "");
    const { data: userData, error: authError } = await admin.auth.getUser(jwt);
    if (authError || !userData?.user) return json({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    const body = (await req.json().catch(() => ({}))) as VerifyDeviceRequest;
    if (!body.device_id || typeof body.device_id !== "string") {
      return json({ error: "device_id required" }, 400);
    }

    const { data, error } = await admin
      .from("customer_active_devices")
      .select("device_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("[verify-device] read error", error);
      // Fail-open: do NOT log the user out on transient backend errors.
      return json({ active: true, server_device_id: null, soft_error: true });
    }

    const serverDeviceId = data?.device_id ?? null;
    const active = serverDeviceId === body.device_id;

    // Refresh last_seen for the active device so admins can see freshness.
    if (active) {
      await admin
        .from("customer_active_devices")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("user_id", userId);
    }

    return json({ active, server_device_id: serverDeviceId });
  } catch (err) {
    console.error("[verify-device] exception", err);
    // Fail-open on unexpected errors.
    return json({ active: true, server_device_id: null, soft_error: true });
  }
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}