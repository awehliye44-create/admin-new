/**
 * save-customer-push-token
 *
 * Bind/rotate the FCM token for the authenticated customer.
 * Requires device_id matching customer_active_devices (claim-device first).
 * Stale devices cannot reclaim via token refresh.
 */
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface SaveTokenRequest {
  token: string;
  platform: string;
  device_id?: string;
  installation_id?: string;
  /** Login takeover: claim device then bind. Refresh omits / sets false. */
  claim?: boolean;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Unauthorized" }, 401);
    }

    const jwt = authHeader.replace("Bearer ", "");
    const { data: userData, error: authError } = await supabase.auth.getUser(
      jwt,
    );

    if (authError || !userData?.user) {
      return json({ error: "Unauthorized" }, 401);
    }

    const body = (await req.json()) as SaveTokenRequest;
    if (!body.token || !body.platform) {
      return json({ error: "Missing token or platform" }, 400);
    }
    if (!["ios", "android"].includes(body.platform)) {
      return json({ error: "Invalid platform" }, 400);
    }

    const deviceId = String(body.device_id ?? body.installation_id ?? "").trim();
    if (!deviceId || deviceId.length < 8) {
      return json({ error: "device_id required" }, 400);
    }

    const userId = userData.user.id;
    const now = new Date().toISOString();
    const wantClaim = body.claim === true;

    const { data: active } = await supabase
      .from("customer_active_devices")
      .select("device_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (wantClaim || !active?.device_id) {
      const { error: claimErr } = await supabase
        .from("customer_active_devices")
        .upsert(
          {
            user_id: userId,
            device_id: deviceId,
            platform: body.platform,
            claimed_at: now,
            last_seen_at: now,
            updated_at: now,
          },
          { onConflict: "user_id" },
        );
      if (claimErr) {
        console.error("[save-customer-push-token] claim failed", claimErr);
        return json({ error: "Failed to claim device" }, 500);
      }
    } else if (active.device_id !== deviceId) {
      return json(
        {
          error: "DEVICE_REPLACED",
          message: "This device is no longer the active Customer session",
          active_device_id: active.device_id,
        },
        409,
      );
    } else {
      await supabase
        .from("customer_active_devices")
        .update({ last_seen_at: now, updated_at: now, platform: body.platform })
        .eq("user_id", userId);
    }

    // Sole selectable token: wipe every other token for this user, then upsert.
    const { error: cleanupError } = await supabase
      .from("customer_push_tokens")
      .delete()
      .eq("user_id", userId)
      .neq("token", body.token);
    if (cleanupError) {
      console.warn(
        "[save-customer-push-token] sibling cleanup failed",
        cleanupError,
      );
    }

    const { error: upsertError } = await supabase
      .from("customer_push_tokens")
      .upsert(
        {
          user_id: userId,
          app_type: "customer",
          platform: body.platform,
          token: body.token,
          updated_at: now,
        },
        { onConflict: "token" },
      );

    if (upsertError) {
      console.error("[save-customer-push-token] upsert failed", upsertError);
      return json({ error: "Failed to save token" }, 500);
    }

    // Concurrent claim race: another device may have inserted a sibling after cleanup.
    await supabase
      .from("customer_push_tokens")
      .delete()
      .eq("user_id", userId)
      .neq("token", body.token);

    console.log(
      `[save-customer-push-token] ok user=${userId} claim=${wantClaim} device=${deviceId.slice(0, 8)}…`,
    );

    return json({ success: true, device_id: deviceId });
  } catch (error) {
    console.error("[save-customer-push-token] exception", error);
    return json({ error: "Internal server error" }, 500);
  }
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
