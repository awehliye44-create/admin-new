/**
 * send-driver-notification — FCM delivery for Driver ride-offer / ops pushes.
 *
 * Invoked by SQL ride_offer_dispatch_push_delivery with body from
 * ride_offer_build_send_notification_body. Honours allowlisted native SSOT
 * channel_id + sound so killed-state Android/iOS play bundled WAVs.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  buildFcmOsAlertBlocks,
  buildStableAlertIdentity,
  DRIVER_NEW_RIDE_OFFER_ANDROID_CHANNEL_ID,
  DRIVER_NEW_RIDE_OFFER_IOS_CATEGORY,
  DRIVER_NEW_RIDE_OFFER_IOS_SOUND,
  enforceAllowlistedOsSoundFields,
  resolveDriverRideOfferOsPush,
} from "../_shared/alertSoundOsPush.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type SendBody = {
  driverId?: string;
  title?: string;
  body?: string;
  type?: string;
  channel_id?: string;
  android_channel_id?: string;
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

function looksLikeRideOfferPush(payload: SendBody, data: Record<string, string>): boolean {
  const notifType = (payload.type || data.type || "").toLowerCase();
  const channel = (
    payload.channel_id ||
    payload.android_channel_id ||
    data.channel_id ||
    ""
  ).toLowerCase();
  return (
    notifType.includes("ride_offer") ||
    notifType.includes("new_ride") ||
    data.offer_id != null ||
    data.offerId != null ||
    channel.includes("ride") ||
    channel === DRIVER_NEW_RIDE_OFFER_ANDROID_CHANNEL_ID.toLowerCase()
  );
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
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    if (token !== serviceKey) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payload = (await req.json()) as SendBody;
    const driverId = payload.driverId?.trim();
    if (!driverId) {
      return new Response(JSON.stringify({ error: "driverId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const title = payload.title?.trim() || "ONECAB";
    const body = payload.body?.trim() || "";
    const data = asStringMap(payload.data);

    const supabase = createClient(supabaseUrl, serviceKey);

    // Defence in depth: suppress new ride-offer pushes when identity blocks dispatch.
    // Primary eligibility must already exclude the driver in find-drivers/auto-dispatch.
    if (looksLikeRideOfferPush(payload, data)) {
      const { data: gate } = await supabase.rpc(
        "get_driver_identity_verification_gate",
        { p_driver_id: driverId },
      );
      if (gate && (gate.dispatch_blocked === true || gate.blocking === true)) {
        return new Response(
          JSON.stringify({
            ok: false,
            suppressed: true,
            code: gate.code || "IDENTITY_VERIFICATION_REQUIRED",
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    // This producer is allowlisted for Driver ride-offer OS contracts only.
    // Prefer stacked/new from explicit flags; payload.type "RIDE_OFFER" / offer_id
    // still resolve even when data.type is an ops alias (e.g. ride_auto_accepted).
    const isRideOffer = looksLikeRideOfferPush(payload, data);
    const typeHint = isRideOffer
      ? data.is_stacked === "true" ||
          data.type === "stacked_ride_offer" ||
          data.type === "STACKED_RIDE_OFFER"
        ? "stacked_ride_offer"
        : "new_ride_offer"
      : data.type || data.event_type || payload.type || "";
    const resolved = resolveDriverRideOfferOsPush(typeHint);
    if (!resolved.ok) {
      console.error("[send-driver-notification] UNKNOWN_EVENT", typeHint);
      return new Response(
        JSON.stringify({ ok: false, error: "UNKNOWN_EVENT", eventKey: typeHint }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const enforced = enforceAllowlistedOsSoundFields(resolved.contract, {
      channelId:
        payload.channel_id ||
        payload.android_channel_id ||
        data.channel_id ||
        null,
      sound: payload.sound || data.sound || null,
    });
    if (enforced.rejectedRequestedSound || enforced.rejectedRequestedChannel) {
      console.warn("[send-driver-notification] rejected unsafe channel/sound override", {
        rejectedSound: enforced.rejectedRequestedSound,
        rejectedChannel: enforced.rejectedRequestedChannel,
      });
    }

    const channelId = enforced.channelId;
    const sound = enforced.sound;
    const category = resolved.contract.category || DRIVER_NEW_RIDE_OFFER_IOS_CATEGORY;

    const identity = buildStableAlertIdentity({
      appRole: "driver",
      adminEventKey: resolved.contract.adminEventKey,
      eventId: data.event_id || data.eventId || null,
      offerId: data.offer_id || data.offerId || null,
      tripId: data.trip_id || data.tripId || data.booking_id || null,
      stateVersion: data.notificationVersion || data.state_version || null,
    });

    data.event_id = identity.event_id;
    data.dedupe_key = identity.dedupe_key;
    data.event_type = identity.event_type;
    data.type = data.type || identity.event_type;
    data.channel_id = channelId;
    data.sound = sound;
    data.category = category;
    if (!data.path && resolved.contract.deepLink) {
      data.path = resolved.contract.deepLink;
    }

    let pushToken: string | null = null;
    let platform = "android";

    // Driver-app tokens only — do not broaden to customer / shared auth tokens.
    const { data: presence } = await supabase
      .from("driver_presence")
      .select("push_token")
      .eq("driver_id", driverId)
      .limit(1)
      .maybeSingle();
    if (presence?.push_token) pushToken = presence.push_token as string;

    if (!pushToken) {
      const { data: row } = await supabase
        .from("push_tokens")
        .select("token, platform")
        .eq("driver_id", driverId)
        .eq("app_type", "driver")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (row?.token) {
        pushToken = row.token as string;
        if (typeof row.platform === "string" && row.platform) {
          platform = row.platform.toLowerCase();
        }
      }
    }

    if (!pushToken) {
      return new Response(JSON.stringify({ ok: false, error: "NO_PUSH_TOKEN" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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
      threadId: "onecab-ride-offers",
      category,
      priority: "HIGH",
      interruptionLevel: resolved.contract.interruptionLevel,
    });

    const message: Record<string, unknown> = {
      token: pushToken,
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
      console.error("[send-driver-notification] FCM failed", errorBody.slice(0, 300));
      return new Response(
        JSON.stringify({ ok: false, error: errorBody.substring(0, 200) }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        channel_id: channelId,
        sound,
        category,
        event_id: identity.event_id,
        dedupe_key: identity.dedupe_key,
        event_type: identity.event_type,
        platform,
        // Sanity: never claim CAF
        ios_sound_contract: DRIVER_NEW_RIDE_OFFER_IOS_SOUND,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("[send-driver-notification]", err);
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "unknown",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
