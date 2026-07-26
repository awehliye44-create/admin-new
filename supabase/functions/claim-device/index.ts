import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface ClaimDeviceRequest {
  device_id: string;
  platform?: string;
  user_agent?: string;
}

/**
 * claim-device
 * Called on customer sign-in. Marks the supplied device_id as the SOLE active
 * device for this user. Any previously-active device will detect the change
 * (via realtime + verify-device) and sign itself out.
 *
 * Side effects:
 *  - upsert customer_active_devices for this user with device_id
 *  - delete every push token for this user that does NOT belong to this device
 *    (we treat the push token itself as the device's notification address)
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
    if (!authHeader) {
      return json({ error: "Unauthorized" }, 401);
    }
    const jwt = authHeader.replace("Bearer ", "");
    const { data: userData, error: authError } = await admin.auth.getUser(jwt);
    if (authError || !userData?.user) {
      return json({ error: "Unauthorized" }, 401);
    }
    const userId = userData.user.id;

    const body = (await req.json().catch(() => ({}))) as ClaimDeviceRequest;
    if (!body.device_id || typeof body.device_id !== "string") {
      return json({ error: "device_id required" }, 400);
    }

    const now = new Date().toISOString();

    const { error: upsertError } = await admin
      .from("customer_active_devices")
      .upsert(
        {
          user_id: userId,
          device_id: body.device_id,
          platform: body.platform ?? null,
          user_agent: body.user_agent ?? null,
          claimed_at: now,
          last_seen_at: now,
          updated_at: now,
        },
        { onConflict: "user_id" },
      );

    if (upsertError) {
      console.error("[claim-device] upsert error", upsertError);
      return json({ error: "Failed to claim device" }, 500);
    }

    // Push-token rotation: delete every push token currently registered for
    // this user (we'll re-register the new one on this device shortly after).
    // This guarantees the OLD device stops receiving notifications immediately.
    const { error: tokenError } = await admin
      .from("customer_push_tokens")
      .delete()
      .eq("user_id", userId);
    if (tokenError) {
      console.warn("[claim-device] failed to clear push tokens", tokenError);
    }

    console.log(`[claim-device] user=${userId} device=${body.device_id}`);

    return json({ success: true, device_id: body.device_id });
  } catch (err) {
    console.error("[claim-device] exception", err);
    return json({ error: "Internal server error" }, 500);
  }
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}