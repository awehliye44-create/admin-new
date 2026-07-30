/**
 * send-customer-trip-notification — FCM delivery for Customer lifecycle alerts.
 *
 * Producers must pass `type` matching Admin Customer alert keys
 * (driver_assigned, driver_arrived, trip_started, trip_completed,
 * trip_cancelled, …). channel_id / sound default to SSOT install names.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  buildFcmOsAlertBlocks,
  customerLifecycleOsPushSound,
} from "../_shared/alertSoundOsPush.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type SendBody = {
  userId?: string;
  customerId?: string;
  title?: string;
  body?: string;
  type?: string;
  tripId?: string;
  channel_id?: string;
  sound?: string;
  data?: Record<string, unknown>;
};

function asStringMap(data: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!data) return out;
  for (const [k, v] of Object.entries(data)) {
    if (v == null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

async function getAccessToken(serviceAccountJson: string): Promise<string> {
  const sa = JSON.parse(serviceAccountJson);
  const iat = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat,
    exp: iat + 3600,
  };
  const enc = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unsigned = `${enc(header)}.${enc(claim)}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  const jwt = `${unsigned}.${btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}`;
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!tokenResponse.ok) throw new Error(`FCM token exchange failed: ${await tokenResponse.text()}`);
  const tokenData = await tokenResponse.json();
  return tokenData.access_token as string;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ") || authHeader.replace("Bearer ", "") !== serviceKey) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payload = (await req.json()) as SendBody;
    const eventKey = (payload.type || payload.data?.type || "general_notification") as string;
    const ssot = customerLifecycleOsPushSound(String(eventKey));
    const channelId = payload.channel_id || ssot.channelId;
    const sound = payload.sound || ssot.sound;
    const title = payload.title?.trim() || "ONECAB";
    const body = payload.body?.trim() || "";
    const data = asStringMap({
      ...payload.data,
      type: eventKey,
      ...(payload.tripId ? { tripId: payload.tripId } : {}),
      channel_id: channelId,
      sound,
    });

    const supabase = createClient(supabaseUrl, serviceKey);
    let userId = payload.userId?.trim() || null;
    if (!userId && payload.customerId) {
      const { data: cust } = await supabase
        .from("customers")
        .select("user_id")
        .eq("id", payload.customerId)
        .maybeSingle();
      userId = typeof cust?.user_id === "string" ? cust.user_id : null;
    }
    if (!userId) {
      return new Response(JSON.stringify({ error: "userId or customerId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: row } = await supabase
      .from("customer_push_tokens")
      .select("token, platform")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!row?.token) {
      return new Response(JSON.stringify({ ok: false, error: "NO_PUSH_TOKEN" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const platform = typeof row.platform === "string" ? row.platform.toLowerCase() : "android";
    const fcmSa = Deno.env.get("FCM_SERVICE_ACCOUNT_JSON");
    const fcmProject = Deno.env.get("FCM_PROJECT_ID");
    if (!fcmSa || !fcmProject) {
      return new Response(JSON.stringify({ ok: false, error: "FCM_NOT_CONFIGURED" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accessToken = await getAccessToken(fcmSa);
    const osBlocks = buildFcmOsAlertBlocks({
      platform,
      title,
      body,
      channelId,
      sound,
      threadId: data.tripId ? `trip-${data.tripId}` : "onecab-customer",
      priority: "HIGH",
    });

    const message: Record<string, unknown> = {
      token: row.token,
      data,
      notification: { title, body },
      ...osBlocks,
    };

    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${fcmProject}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message }),
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      return new Response(
        JSON.stringify({ ok: false, error: errorBody.substring(0, 200) }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({ ok: true, channel_id: channelId, sound, platform }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
