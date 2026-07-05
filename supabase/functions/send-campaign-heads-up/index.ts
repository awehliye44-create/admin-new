/**
 * send-campaign-heads-up — dispatches Campaign / Celebration notifications (System B).
 * Never routes through send-trip-notification or operational heads-up pipeline.
 */
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CAMPAIGN_PUSH_LAYER = "campaign";
const CAMPAIGN_PUSH_TYPE = "campaign_heads_up";

interface SendCampaignRequest {
  campaignId: string;
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

async function sendFCMv1(
  projectId: string,
  accessToken: string,
  token: string,
  platform: string,
  title: string,
  body: string,
  data: Record<string, string>,
): Promise<{ success: boolean; error?: string }> {
  const message: Record<string, unknown> = {
    token,
    data,
    notification: { title, body },
  };
  if (platform === "android") {
    (message as Record<string, unknown>).android = {
      priority: "NORMAL",
      notification: {
        channel_id: "promotions",
        tag: data.notificationId,
      },
    };
  } else if (platform === "ios") {
    (message as Record<string, unknown>).apns = {
      headers: { "apns-priority": "5", "apns-push-type": "alert" },
      payload: {
        aps: {
          alert: { title, body },
          "thread-id": data.campaignId,
          category: CAMPAIGN_PUSH_TYPE,
        },
      },
    };
  }
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
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
    if (response.status === 404 || response.status === 410 || errorBody.includes("UNREGISTERED")) {
      return { success: false, error: "TOKEN_INVALID" };
    }
    return { success: false, error: errorBody.substring(0, 200) };
  }
  return { success: true };
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

    const supabase = createClient(supabaseUrl, serviceKey);
    const token = authHeader.replace("Bearer ", "");
    const isService = token === serviceKey;
    if (!isService) {
      const { data: userData, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userData.user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const { campaignId } = (await req.json()) as SendCampaignRequest;
    if (!campaignId) {
      return new Response(JSON.stringify({ error: "campaignId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: campaign, error: campaignErr } = await supabase
      .from("campaign_heads_up_campaigns")
      .select("*")
      .eq("id", campaignId)
      .single();
    if (campaignErr || !campaign) {
      return new Response(JSON.stringify({ error: "Campaign not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await supabase
      .from("campaign_heads_up_campaigns")
      .update({ status: "sending", updated_at: new Date().toISOString() })
      .eq("id", campaignId);

    const targetApps: Array<"customer" | "driver"> =
      campaign.target_app === "both" ? ["customer", "driver"] :
      campaign.target_app === "driver" ? ["driver"] : ["customer"];

    const fcmSa = Deno.env.get("FCM_SERVICE_ACCOUNT_JSON");
    const fcmProject = Deno.env.get("FCM_PROJECT_ID");
    let accessToken: string | null = null;
    if (fcmSa && fcmProject) {
      accessToken = await getAccessToken(fcmSa);
    }

    let sent = 0;
    let delivered = 0;
    let failed = 0;

    for (const app of targetApps) {
      const table = app === "customer" ? "customer_push_tokens" : "push_tokens";
      let userIds: string[] | null = null;

      if (campaign.target_scope === "users" && Array.isArray(campaign.target_user_ids)) {
        userIds = campaign.target_user_ids as string[];
      }

      let tokenQuery = supabase.from(table).select("id, user_id, token, platform");
      if (userIds?.length) {
        tokenQuery = tokenQuery.in("user_id", userIds);
      }

      const { data: tokens, error: tokenErr } = await tokenQuery;
      if (tokenErr) throw tokenErr;

      for (const row of tokens ?? []) {
        const dedupeKey = `${campaignId}:${row.user_id}:${app}`;
        const { error: deliveryInsertErr } = await supabase.from("campaign_heads_up_deliveries").upsert({
          campaign_id: campaignId,
          user_id: row.user_id,
          user_app: app,
          status: "pending",
          dedupe_key: dedupeKey,
        }, { onConflict: "campaign_id,user_id,user_app" });
        if (deliveryInsertErr) continue;

        sent += 1;
        const notificationId = dedupeKey;
        const dataPayload: Record<string, string> = {
          layer: CAMPAIGN_PUSH_LAYER,
          type: CAMPAIGN_PUSH_TYPE,
          campaignId,
          notificationId,
          title: campaign.title,
          body: campaign.subtitle,
          subtitle: campaign.subtitle,
          emoji: campaign.emoji ?? "",
          accentColor: campaign.accent_color ?? "blue",
          gradientFrom: campaign.gradient_from ?? "",
          gradientTo: campaign.gradient_to ?? "",
          backgroundImageUrl: campaign.background_image_url ?? "",
          ctaLabel: campaign.cta_label ?? "",
          ctaUrl: campaign.cta_url ?? campaign.deep_link ?? "",
          deepLink: campaign.deep_link ?? campaign.cta_url ?? "",
          screen: campaign.deep_link ?? campaign.cta_url ?? "/",
          priority: "normal",
          channelId: "promotions",
        };

        if (!accessToken || !fcmProject) {
          await supabase.from("campaign_heads_up_deliveries").update({
            status: "delivered",
            delivered_at: new Date().toISOString(),
          }).eq("dedupe_key", dedupeKey);
          delivered += 1;
          continue;
        }

        const result = await sendFCMv1(
          fcmProject,
          accessToken,
          row.token,
          row.platform,
          campaign.title,
          campaign.subtitle,
          dataPayload,
        );

        if (result.success) {
          delivered += 1;
          await supabase.from("campaign_heads_up_deliveries").update({
            status: "delivered",
            delivered_at: new Date().toISOString(),
          }).eq("dedupe_key", dedupeKey);
        } else {
          failed += 1;
          await supabase.from("campaign_heads_up_deliveries").update({
            status: "failed",
            failed_at: new Date().toISOString(),
            failure_reason: result.error ?? "unknown",
          }).eq("dedupe_key", dedupeKey);
          if (result.error === "TOKEN_INVALID") {
            await supabase.from(table).delete().eq("id", row.id);
          }
        }
      }
    }

    await supabase.from("campaign_heads_up_campaigns").update({
      status: "sent",
      sent_at: new Date().toISOString(),
      sent_count: sent,
      delivered_count: delivered,
      failed_count: failed,
      updated_at: new Date().toISOString(),
    }).eq("id", campaignId);

    return new Response(JSON.stringify({ ok: true, sent, delivered, failed }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("send-campaign-heads-up error", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
