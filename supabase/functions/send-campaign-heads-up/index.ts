/**
 * send-campaign-heads-up — dispatches Campaign / Celebration notifications (System B).
 * Never routes through send-trip-notification or operational heads-up pipeline.
 *
 * Body `{ campaignId }` — admin/staff send one campaign.
 * Body `{ source: "pg_cron" }` (no campaignId) — due scheduled / repeat sweep.
 */
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.0";
import {
  resolveCustomerAuthoritativeToken,
  resolveDriverAuthoritativeToken,
} from "../_shared/authoritativeDevicePush.ts";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import {
  chunkIds,
  listActiveCustomerUserIds,
  listActiveDriverIds,
  resolveCampaignAudience,
  resolveCustomerUserIdsForAudience,
  resolveDriverIdsForAudience,
} from "../_shared/campaignHeadsUpAudience.ts";
import {
  buildCampaignHeadsUpFcmData,
  CAMPAIGN_ANDROID_CHANNEL_ID,
  CAMPAIGN_IOS_CATEGORY,
  campaignApnsPriority,
  campaignFcmAndroidPriority,
  campaignIsDueAt,
  campaignIsExpiredAt,
  campaignTargetApps,
  isRepeatCampaignScheduleMode,
  nextRepeatDueAfter,
  campaignDeliveryDedupeKey,
  normalizeCampaignPushPlatform,
  readCampaignFcmServiceAccountJson,
} from "../_shared/campaignHeadsUpPayload.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
};

interface SendCampaignRequest {
  campaignId?: string;
  source?: string;
}

type CampaignToken = {
  user_id: string;
  token: string;
  platform: "ios" | "android";
};

type CampaignRow = Record<string, unknown> & {
  id: string;
  title: string;
  subtitle: string;
  target_app: string;
  status: string;
  schedule_mode: string | null;
  scheduled_at: string | null;
  starts_at: string | null;
  ends_at: string | null;
  priority: string | null;
  sent_count?: number | null;
  delivered_count?: number | null;
  failed_count?: number | null;
};

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
  platform: "ios" | "android",
  title: string,
  body: string,
  data: Record<string, string>,
  priority: string | null | undefined,
): Promise<{ success: boolean; error?: string }> {
  const androidPriority = campaignFcmAndroidPriority(priority);
  const apnsPriority = campaignApnsPriority(priority);
  const message: Record<string, unknown> = {
    token,
    data,
    notification: { title, body },
  };
  if (platform === "android") {
    message.android = {
      priority: androidPriority,
      notification: {
        channel_id: CAMPAIGN_ANDROID_CHANNEL_ID,
        tag: data.notificationId,
        notification_priority: priority === "high" ? "PRIORITY_HIGH" : "PRIORITY_DEFAULT",
      },
    };
  } else {
    message.apns = {
      headers: { "apns-priority": apnsPriority, "apns-push-type": "alert" },
      payload: {
        aps: {
          alert: { title, body },
          sound: "default",
          "thread-id": data.campaignId,
          category: CAMPAIGN_IOS_CATEGORY,
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

async function deactivateInvalidPushToken(
  supabase: ReturnType<typeof createClient>,
  app: "customer" | "driver",
  token: string,
): Promise<void> {
  if (app === "customer") {
    await supabase.from("customer_push_tokens").delete().eq("token", token);
    return;
  }
  await supabase
    .from("push_tokens")
    .update({ is_active: false })
    .eq("token", token)
    .eq("app_type", "driver");
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R | null>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const out: R[] = [];
  let next = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        const result = await fn(items[i]);
        if (result != null) out.push(result);
      }
    }),
  );
  return out;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function requireAdminOrStaff(
  supabase: ReturnType<typeof createClient>,
  bearer: string,
  serviceKey: string,
): Promise<Response | null> {
  if (bearer === serviceKey) return null;
  const { data: userData, error: userErr } = await supabase.auth.getUser(bearer);
  if (userErr || !userData.user) return jsonResponse({ error: "Unauthorized" }, 401);
  const uid = userData.user.id;
  const [{ data: adminRole }, { data: staffRow }] = await Promise.all([
    supabase.from("user_roles").select("role").eq("user_id", uid).eq("role", "admin").maybeSingle(),
    supabase.from("staff_profiles").select("id").eq("user_id", uid).eq("is_active", true).maybeSingle(),
  ]);
  if (!adminRole && !staffRow) {
    return jsonResponse({ error: "Forbidden — admin or staff role required" }, 403);
  }
  return null;
}

async function resolveFcm(): Promise<
  { ok: true; sa: string; projectId: string } | { ok: false; response: Response }
> {
  const fcmSa = readCampaignFcmServiceAccountJson();
  let fcmProject: string | null = null;
  if (fcmSa) {
    try {
      const parsed = JSON.parse(fcmSa) as { project_id?: unknown };
      fcmProject = typeof parsed.project_id === "string" ? parsed.project_id : null;
    } catch {
      fcmProject = null;
    }
  }
  if (!fcmSa || !fcmProject) {
    return { ok: false, response: jsonResponse({ error: "FCM_NOT_CONFIGURED" }, 503) };
  }
  return { ok: true, sa: fcmSa, projectId: fcmProject };
}

async function collectTokens(
  supabase: ReturnType<typeof createClient>,
  campaign: CampaignRow,
): Promise<Array<CampaignToken & { app: "customer" | "driver" }>> {
  const audience = await resolveCampaignAudience(supabase, campaign);
  if (!audience.ok) throw new Error(audience.error);

  const tokens: Array<CampaignToken & { app: "customer" | "driver" }> = [];
  const seen = new Set<string>();

  for (const app of campaignTargetApps(campaign.target_app)) {
    if (app === "customer") {
      const userIds = await resolveCustomerUserIdsForAudience(supabase, audience);
      const activeUserIds = await listActiveCustomerUserIds(supabase, userIds);
      const resolved = await mapPool(activeUserIds, 16, async (userId) => {
        const authoritative = await resolveCustomerAuthoritativeToken(supabase, userId);
        if (!authoritative?.token) return null;
        return {
          app,
          user_id: userId,
          token: authoritative.token,
          platform: normalizeCampaignPushPlatform(authoritative.platform),
        } satisfies CampaignToken & { app: "customer" | "driver" };
      });
      for (const row of resolved) {
        const key = `${row.app}:${row.user_id}:${row.token}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tokens.push(row);
      }
      continue;
    }

    const driverIds = await resolveDriverIdsForAudience(supabase, audience);
    const activeDriverIds = await listActiveDriverIds(supabase, driverIds);
    const driverUserIds = new Map<string, string>();
    for (const chunk of chunkIds(activeDriverIds)) {
      const { data, error } = await supabase
        .from("drivers")
        .select("id, user_id")
        .in("id", chunk)
        .is("deleted_at", null);
      if (error) throw error;
      for (const row of data ?? []) {
        if (row.id && row.user_id) driverUserIds.set(row.id, row.user_id);
      }
    }
    const resolved = await mapPool(activeDriverIds, 16, async (driverId) => {
      const uid = driverUserIds.get(driverId);
      if (!uid) return null;
      const authoritative = await resolveDriverAuthoritativeToken(supabase, driverId);
      if (!authoritative?.token) return null;
      return {
        app,
        user_id: uid,
        token: authoritative.token,
        platform: normalizeCampaignPushPlatform(authoritative.platform),
      } satisfies CampaignToken & { app: "customer" | "driver" };
    });
    for (const row of resolved) {
      const key = `${row.app}:${row.user_id}:${row.token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tokens.push(row);
    }
  }

  return tokens;
}

/** Stale pending deliveries may be reclaimed after a crashed mid-send worker. */
const DELIVERY_CLAIM_STALE_MS = 2 * 60 * 1000;
/** Keep campaign.updated_at fresh so another worker does not reclaim mid-dispatch. */
const CAMPAIGN_SEND_HEARTBEAT_MS = 60 * 1000;
/** Stuck `sending` rows (worker crash / no heartbeat) may be reclaimed after this. */
const CAMPAIGN_STALE_SENDING_MS = 15 * 60 * 1000;

type DeliveryClaim = "send" | "skip_done" | "skip_busy" | "fail";

/**
 * Atomically claim the right to FCM-send one delivery occurrence.
 * Insert wins; otherwise reclaim failed / stale pending only — never downgrade
 * delivered/opened/tapped/dismissed, and never steal a fresh in-flight pending.
 */
async function claimCampaignDelivery(
  supabase: ReturnType<typeof createClient>,
  opts: {
    campaignId: string;
    userId: string;
    userApp: "customer" | "driver";
    dedupeKey: string;
  },
): Promise<DeliveryClaim> {
  const claimedAt = new Date().toISOString();
  const { data: inserted, error: insertErr } = await supabase
    .from("campaign_heads_up_deliveries")
    .insert({
      campaign_id: opts.campaignId,
      user_id: opts.userId,
      user_app: opts.userApp,
      status: "pending",
      dedupe_key: opts.dedupeKey,
      claimed_at: claimedAt,
    })
    .select("id")
    .maybeSingle();
  if (!insertErr && inserted) return "send";

  const { data: reclaimedFailed } = await supabase
    .from("campaign_heads_up_deliveries")
    .update({
      status: "pending",
      claimed_at: claimedAt,
      failed_at: null,
      failure_reason: null,
    })
    .eq("dedupe_key", opts.dedupeKey)
    .eq("status", "failed")
    .select("id")
    .maybeSingle();
  if (reclaimedFailed) return "send";

  const staleBefore = new Date(Date.now() - DELIVERY_CLAIM_STALE_MS).toISOString();
  const { data: reclaimedStale } = await supabase
    .from("campaign_heads_up_deliveries")
    .update({
      status: "pending",
      claimed_at: claimedAt,
    })
    .eq("dedupe_key", opts.dedupeKey)
    .eq("status", "pending")
    .lt("claimed_at", staleBefore)
    .select("id")
    .maybeSingle();
  if (reclaimedStale) return "send";

  const { data: reclaimedNullClaim } = await supabase
    .from("campaign_heads_up_deliveries")
    .update({
      status: "pending",
      claimed_at: claimedAt,
    })
    .eq("dedupe_key", opts.dedupeKey)
    .eq("status", "pending")
    .is("claimed_at", null)
    .select("id")
    .maybeSingle();
  if (reclaimedNullClaim) return "send";

  const { data: existing } = await supabase
    .from("campaign_heads_up_deliveries")
    .select("status")
    .eq("dedupe_key", opts.dedupeKey)
    .maybeSingle();
  const existingStatus = typeof existing?.status === "string" ? existing.status : "";
  if (
    existingStatus === "delivered" ||
    existingStatus === "opened" ||
    existingStatus === "tapped" ||
    existingStatus === "dismissed"
  ) {
    return "skip_done";
  }
  if (existingStatus === "pending") return "skip_busy";
  return "fail";
}

async function dispatchCampaign(opts: {
  supabase: ReturnType<typeof createClient>;
  campaign: CampaignRow;
  projectId: string;
  accessToken: string;
  revertStatus: string;
}): Promise<{ sent: number; delivered: number; failed: number; noReach?: boolean }> {
  const { supabase, campaign, projectId, accessToken, revertStatus } = opts;
  const campaignId = campaign.id;
  const now = new Date();

  if (campaignIsExpiredAt(now, campaign)) {
    await supabase.from("campaign_heads_up_campaigns").update({
      status: "expired",
      updated_at: now.toISOString(),
    }).eq("id", campaignId).eq("status", "sending");
    return { sent: 0, delivered: 0, failed: 0 };
  }

  let sent = 0;
  let delivered = 0;
  let failed = 0;

  try {
    const tokens = await collectTokens(supabase, campaign);
    const repeat = isRepeatCampaignScheduleMode(campaign.schedule_mode);
    const occurrenceAt = repeat
      ? (campaign.scheduled_at || campaign.starts_at || now.toISOString())
      : null;

    let lastHeartbeatMs = Date.now();
    const heartbeatSending = async () => {
      const t = Date.now();
      if (t - lastHeartbeatMs < CAMPAIGN_SEND_HEARTBEAT_MS) return;
      lastHeartbeatMs = t;
      await supabase.from("campaign_heads_up_campaigns").update({
        updated_at: new Date().toISOString(),
      }).eq("id", campaignId).eq("status", "sending");
    };

    const outcomes = await mapPool(tokens, 8, async (row) => {
      await heartbeatSending();
      const dedupeKey = campaignDeliveryDedupeKey({
        campaignId,
        userId: row.user_id,
        app: row.app,
        occurrenceAt,
      });
      const claim = await claimCampaignDelivery(supabase, {
        campaignId,
        userId: row.user_id,
        userApp: row.app,
        dedupeKey,
      });
      // Already delivered (or in-flight elsewhere): do not inflate sent_count.
      if (claim === "skip_done" || claim === "skip_busy") {
        return { sent: 0, delivered: 0, failed: 0 };
      }
      if (claim === "fail") {
        return { sent: 0, delivered: 0, failed: 1 };
      }

      const dataPayload = buildCampaignHeadsUpFcmData({
        campaignId,
        notificationId: dedupeKey,
        title: campaign.title,
        subtitle: campaign.subtitle,
        emoji: campaign.emoji as string | null,
        accentColor: campaign.accent_color as string | null,
        gradientFrom: campaign.gradient_from as string | null,
        gradientTo: campaign.gradient_to as string | null,
        backgroundImageUrl: campaign.background_image_url as string | null,
        ctaLabel: campaign.cta_label as string | null,
        ctaUrl: campaign.cta_url as string | null,
        deepLink: campaign.deep_link as string | null,
        priority: campaign.priority,
      });

      const result = await sendFCMv1(
        projectId,
        accessToken,
        row.token,
        row.platform,
        dataPayload.title,
        dataPayload.subtitle,
        dataPayload,
        campaign.priority,
      );

      if (result.success) {
        await supabase.from("campaign_heads_up_deliveries").update({
          status: "delivered",
          delivered_at: new Date().toISOString(),
        }).eq("dedupe_key", dedupeKey).in("status", ["pending", "failed"]);
        return { sent: 1, delivered: 1, failed: 0 };
      }

      await supabase.from("campaign_heads_up_deliveries").update({
        status: "failed",
        failed_at: new Date().toISOString(),
        failure_reason: result.error ?? "unknown",
      }).eq("dedupe_key", dedupeKey).eq("status", "pending");
      if (result.error === "TOKEN_INVALID") {
        await deactivateInvalidPushToken(supabase, row.app, row.token);
      }
      return { sent: 1, delivered: 0, failed: 1 };
    });

    for (const outcome of outcomes) {
      sent += outcome.sent;
      delivered += outcome.delivered;
      failed += outcome.failed;
    }

    const dueRaw = campaign.scheduled_at || campaign.starts_at;
    const dueDate = dueRaw ? new Date(dueRaw) : now;
    const nextAt = repeat
      ? nextRepeatDueAfter(
        campaign.schedule_mode,
        Number.isNaN(dueDate.getTime()) ? now : dueDate,
        now,
      )
      : null;
    const nextExpired = nextAt != null && campaignIsExpiredAt(nextAt, campaign);
    const noReachThisRun =
      tokens.length === 0 && sent === 0 && delivered === 0 && failed === 0;

    if (noReachThisRun && !repeat && !nextAt) {
      await supabase.from("campaign_heads_up_campaigns").update({
        status: revertStatus,
        updated_at: new Date().toISOString(),
      }).eq("id", campaignId).eq("status", "sending");
      return { sent, delivered, failed, noReach: true };
    }

    await supabase.from("campaign_heads_up_campaigns").update({
      status: nextExpired ? "expired" : nextAt ? "scheduled" : "sent",
      scheduled_at: nextExpired || !nextAt ? campaign.scheduled_at : nextAt.toISOString(),
      sent_at: new Date().toISOString(),
      sent_count: Number(campaign.sent_count ?? 0) + sent,
      updated_at: new Date().toISOString(),
    }).eq("id", campaignId).eq("status", "sending");

    return { sent, delivered, failed, noReach: false };
  } catch (err) {
    await supabase.from("campaign_heads_up_campaigns").update({
      status: revertStatus,
      updated_at: new Date().toISOString(),
    }).eq("id", campaignId).eq("status", "sending");
    throw err;
  }
}

async function claimCampaign(
  supabase: ReturnType<typeof createClient>,
  campaignId: string,
): Promise<{ campaign: CampaignRow; revertStatus: string } | null> {
  const { data: campaign, error } = await supabase
    .from("campaign_heads_up_campaigns")
    .select("*")
    .eq("id", campaignId)
    .single();
  if (error || !campaign) return null;

  const revertStatus =
    campaign.status === "scheduled" ||
    (campaign.status === "sending" &&
      (isRepeatCampaignScheduleMode(campaign.schedule_mode) ||
        campaign.schedule_mode === "scheduled" ||
        Boolean(campaign.scheduled_at)))
      ? "scheduled"
      : "draft";

  const { data: claimedFresh } = await supabase
    .from("campaign_heads_up_campaigns")
    .update({ status: "sending", updated_at: new Date().toISOString() })
    .eq("id", campaignId)
    .in("status", ["draft", "scheduled"])
    .select("id")
    .maybeSingle();
  if (claimedFresh) return { campaign: campaign as CampaignRow, revertStatus };

  const updatedAt = Date.parse(String(campaign.updated_at ?? ""));
  const isStaleSending =
    campaign.status === "sending" &&
    Number.isFinite(updatedAt) &&
    Date.now() - updatedAt > CAMPAIGN_STALE_SENDING_MS;
  if (!isStaleSending) return null;

  const { data: claimedStale } = await supabase
    .from("campaign_heads_up_campaigns")
    .update({ status: "sending", updated_at: new Date().toISOString() })
    .eq("id", campaignId)
    .eq("status", "sending")
    .lte("updated_at", new Date(Date.now() - CAMPAIGN_STALE_SENDING_MS).toISOString())
    .select("id")
    .maybeSingle();
  if (!claimedStale) return null;
  return { campaign: campaign as CampaignRow, revertStatus };
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
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const supabase = createClient(supabaseUrl, serviceKey);
    const body = (await req.json().catch(() => ({}))) as SendCampaignRequest;
    const campaignId = typeof body.campaignId === "string" ? body.campaignId.trim() : "";
    const isSweep = !campaignId &&
      (body.source === "pg_cron" || body.source === "cron");

    if (isSweep) {
      const cron = await assertCronOrServiceRoleAuth(req, body as Record<string, unknown>);
      if (!cron.ok) return cron.response;
    } else {
      const denied = await requireAdminOrStaff(
        supabase,
        authHeader.replace("Bearer ", ""),
        serviceKey,
      );
      if (denied) return denied;
      if (!campaignId) return jsonResponse({ error: "campaignId required" }, 400);
    }

    if (!isSweep) {
      const fcm = await resolveFcm();
      if (!fcm.ok) return fcm.response;
      const accessToken = await getAccessToken(fcm.sa);
      const claimed = await claimCampaign(supabase, campaignId);
      if (!claimed) {
        return jsonResponse(
          { error: "Campaign not found, already sending, or still within the 15-minute send lock" },
          404,
        );
      }
      const result = await dispatchCampaign({
        supabase,
        campaign: claimed.campaign,
        projectId: fcm.projectId,
        accessToken,
        revertStatus: claimed.revertStatus,
      });
      return jsonResponse({ ok: true, ...result });
    }

    const now = new Date();
    const dueRows: CampaignRow[] = [];
    const page = 100;
    let from = 0;
    for (;;) {
      const { data: scheduledRows, error: dueErr } = await supabase
        .from("campaign_heads_up_campaigns")
        .select("*")
        .eq("status", "scheduled")
        .order("scheduled_at", { ascending: true, nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, from + page - 1);
      if (dueErr) throw dueErr;
      const rows = scheduledRows ?? [];
      for (const row of rows) {
        const campaign = row as CampaignRow;
        if (campaignIsExpiredAt(now, campaign) || campaignIsDueAt(now, campaign)) {
          dueRows.push(campaign);
        }
      }
      if (rows.length < page) break;
      from += page;
    }

    // Crashed mid-send workers leave status=sending; reclaim after heartbeat window.
    const staleSendingCutoff = new Date(Date.now() - CAMPAIGN_STALE_SENDING_MS).toISOString();
    const staleSending: CampaignRow[] = [];
    from = 0;
    for (;;) {
      const { data: sendingRows, error: sendingErr } = await supabase
        .from("campaign_heads_up_campaigns")
        .select("*")
        .eq("status", "sending")
        .lte("updated_at", staleSendingCutoff)
        .order("updated_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + page - 1);
      if (sendingErr) throw sendingErr;
      const rows = sendingRows ?? [];
      for (const row of rows) staleSending.push(row as CampaignRow);
      if (rows.length < page) break;
      from += page;
    }

    let dispatched = 0;
    let sent = 0;
    let delivered = 0;
    let failed = 0;
    const MAX_SWEEP_DISPATCH = 25;
    let expired = 0;
    const dueToSend: CampaignRow[] = [];
    const seenIds = new Set<string>();
    for (const campaign of dueRows) {
      if (campaignIsExpiredAt(now, campaign)) {
        if (expired >= 100) continue;
        await supabase.from("campaign_heads_up_campaigns").update({
          status: "expired",
          updated_at: now.toISOString(),
        }).eq("id", campaign.id).eq("status", "scheduled");
        expired += 1;
        continue;
      }
      if (campaignIsDueAt(now, campaign)) {
        seenIds.add(campaign.id);
        dueToSend.push(campaign);
      }
    }
    for (const campaign of staleSending) {
      if (seenIds.has(campaign.id)) continue;
      seenIds.add(campaign.id);
      dueToSend.push(campaign);
    }

    if (dueToSend.length === 0) {
      return jsonResponse({ ok: true, sweep: true, dispatched: 0, sent: 0, delivered: 0, failed: 0, expired });
    }

    const fcm = await resolveFcm();
    if (!fcm.ok) return fcm.response;
    const accessToken = await getAccessToken(fcm.sa);

    for (const campaign of dueToSend) {
      if (dispatched >= MAX_SWEEP_DISPATCH) break;
      const claimed = await claimCampaign(supabase, campaign.id);
      if (!claimed) continue;
      const result = await dispatchCampaign({
        supabase,
        campaign: claimed.campaign,
        projectId: fcm.projectId,
        accessToken,
        revertStatus: claimed.revertStatus,
      });
      dispatched += 1;
      sent += result.sent;
      delivered += result.delivered;
      failed += result.failed;
    }

    return jsonResponse({ ok: true, sweep: true, dispatched, sent, delivered, failed, expired });
  } catch (err) {
    console.error("send-campaign-heads-up error", err);
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});
