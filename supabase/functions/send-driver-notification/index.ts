/**
 * send-driver-notification — driver ride-offer heads-up push (FCM v1).
 *
 * Ride offers are ACTIONABLE notifications: the Android heads-up must persist
 * for the full offer window (until `expires_at`) and must NOT auto-dismiss.
 * That is enforced here via android.notification.sticky = true,
 * notification_priority = PRIORITY_MAX and an explicit TTL bound to the offer
 * expiry. Auto-dismissing heads-ups are reserved for campaign notifications.
 */
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface NotificationRequest {
  driverId: string;
  type?: string;
  title?: string;
  body?: string;
  channel_id?: string;
  android_channel_id?: string;
  sound?: string;
  data?: Record<string, string>;
}

async function getAccessToken(serviceAccountJson: string): Promise<string> {
  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const enc = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unsignedToken = `${enc(JSON.stringify(header))}.${enc(JSON.stringify(payload))}`;
  const pemContents = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\n/g, "");
  const keyBuffer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsignedToken),
  );
  const jwt = `${unsignedToken}.${enc(String.fromCharCode(...new Uint8Array(signature)))}`;
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!tokenResponse.ok) throw new Error(`FCM token exchange failed: ${await tokenResponse.text()}`);
  const tokenData = await tokenResponse.json();
  return tokenData.access_token as string;
}

/** Seconds remaining on the offer, clamped to a sane FCM TTL window. */
function offerTtlSeconds(data: Record<string, string>): number {
  const raw = data.expiresAt || data.expires_at || "";
  const expiry = raw ? Date.parse(raw) : NaN;
  if (!Number.isFinite(expiry)) return 60;
  const secs = Math.ceil((expiry - Date.now()) / 1000);
  return Math.min(Math.max(secs, 15), 300);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Internal-only endpoint: invoked by Postgres dispatch with the service key.
    const authHeader = req.headers.get("Authorization") ?? "";
    if (authHeader.replace("Bearer ", "").trim() !== serviceKey) {
      return json({ error: "Unauthorized" }, 401);
    }

    const payload = (await req.json()) as NotificationRequest;
    if (!payload?.driverId) return json({ error: "driverId required" }, 400);

    const supabase = createClient(supabaseUrl, serviceKey);
    const data: Record<string, string> = { ...(payload.data ?? {}) };
    const isRideOffer =
      (payload.type ?? "").toUpperCase() === "RIDE_OFFER" ||
      (data.type ?? "").toUpperCase() === "NEW_RIDE_OFFER";

    // Admin Alert Sounds SSOT: resolve the configured sound for this driver event.
    const eventType = isRideOffer
      ? "new_ride_offer"
      : (data.event_type || payload.type || "").toLowerCase();

    let mappedSoundFile: string | null = null;
    let mappedSoundUrl: string | null = null;
    if (eventType) {
      const { data: mapping } = await supabase
        .from("alert_sound_mappings")
        .select("alert_sounds(storage_path, is_active)")
        .eq("target_app", "driver")
        .eq("event_type", eventType)
        .eq("is_active", true)
        .maybeSingle();
      const mapped = (mapping as { alert_sounds?: { storage_path: string; is_active: boolean } } | null)
        ?.alert_sounds;
      if (mapped?.is_active && mapped.storage_path) {
        mappedSoundFile = mapped.storage_path.split("/").pop() ?? null;
        mappedSoundUrl = supabase.storage.from("alert-sounds").getPublicUrl(mapped.storage_path)
          .data.publicUrl;
      }
    }

    const sound = payload.sound ?? mappedSoundFile ?? "onecab_new_ride_offer.wav";
    const soundKey = sound.replace(/\.[^.]+$/, "");

    // Android bakes the sound into the channel at creation time, so the channel
    // id must change whenever the configured sound changes.
    const channelId =
      payload.android_channel_id ??
      payload.channel_id ??
      (isRideOffer ? `onecab_ride_offer_${soundKey}` : `onecab_${soundKey}`);
    const title = payload.title ?? "New ride offer available near you!";
    const body = payload.body ?? "Tap to view details";
    const ttl = isRideOffer ? offerTtlSeconds(data) : 300;


    const { data: tokens, error: tokenErr } = await supabase
      .from("push_tokens")
      .select("id, token, platform")
      .eq("driver_id", payload.driverId)
      .eq("app_type", "driver");
    if (tokenErr) throw tokenErr;
    if (!tokens?.length) return json({ ok: true, sent: 0, reason: "no_token" });

    const fcmSa = Deno.env.get("FCM_SERVICE_ACCOUNT_JSON");
    const fcmProject = Deno.env.get("FCM_PROJECT_ID");
    if (!fcmSa || !fcmProject) {
      return json({ ok: false, sent: 0, reason: "fcm_not_configured" }, 503);
    }
    const accessToken = await getAccessToken(fcmSa);

    let sent = 0;
    let failed = 0;

    for (const row of tokens) {
      const message: Record<string, unknown> = {
        token: row.token,
        data: { ...data, title, body, channelId, sound },
      };

      if (row.platform === "ios") {
        message.apns = {
          headers: {
            "apns-priority": "10",
            "apns-push-type": "alert",
            "apns-expiration": String(Math.floor(Date.now() / 1000) + ttl),
          },
          payload: {
            aps: {
              alert: { title, body },
              sound: { critical: 0, name: sound, volume: 1.0 },
              "interruption-level": isRideOffer ? "time-sensitive" : "active",
              "thread-id": data.offer_id ?? data.trip_id ?? "ride_offer",
              category: isRideOffer ? "NEW_RIDE_OFFER" : "GENERAL",
            },
          },
        };
      } else {
        message.android = {
          priority: "HIGH",
          ttl: `${ttl}s`,
          notification: {
            channel_id: channelId,
            sound: sound.replace(/\.[^.]+$/, ""),
            // Actionable offer: keep the heads-up on screen for the whole
            // offer window — never auto-dismiss, never auto-cancel on tap.
            sticky: isRideOffer,
            notification_priority: isRideOffer ? "PRIORITY_MAX" : "PRIORITY_DEFAULT",
            visibility: "PUBLIC",
            default_vibrate_timings: true,
            tag: data.offer_id ?? data.trip_id ?? undefined,
          },
        };
      }

      // Ride offers are rendered by the app's own full-screen offer card, so the
      // OS alert block is only used as the transport-level heads-up fallback.
      message.notification = { title, body };

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

      if (response.ok) {
        sent += 1;
      } else {
        failed += 1;
        const errorBody = await response.text();
        console.error("[send-driver-notification] fcm_error", response.status, errorBody.slice(0, 300));
        if (
          response.status === 404 ||
          response.status === 410 ||
          errorBody.includes("UNREGISTERED")
        ) {
          await supabase.from("push_tokens").delete().eq("id", row.id);
        }
      }
    }

    return json({ ok: true, sent, failed, ttl });
  } catch (err) {
    console.error("send-driver-notification error", err);
    return json({ error: (err as Error).message }, 500);
  }
});
