/**
 * Lock: Campaign / Celebration Heads-Up stays System B — never trip pipeline,
 * never fake-delivers without FCM, never crashes TOKEN_INVALID cleanup.
 *
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

import {
  buildCampaignHeadsUpFcmData,
  CAMPAIGN_ANDROID_CHANNEL_ID,
  CAMPAIGN_PUSH_LAYER,
  CAMPAIGN_PUSH_TYPE,
  campaignIsDueAt,
  campaignTargetApps,
  nextRepeatDueAfter,
  nextRepeatScheduledAt,
  campaignDeliveryDedupeKey,
  normalizeCampaignPushPlatform,
} from "./campaignHeadsUpPayload.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(join(REPO_ROOT, rel));
}

Deno.test("campaign heads-up payload is System B, not trip events", () => {
  const data = buildCampaignHeadsUpFcmData({
    campaignId: "c1",
    notificationId: "n1",
    title: "Eid Mubarak",
    subtitle: "Warm wishes",
    emoji: "🕌",
    gradientFrom: "#166534",
    gradientTo: "#86efac",
    ctaLabel: "See Details",
    deepLink: "/promotions/eid",
  });
  assertEquals(data.type, CAMPAIGN_PUSH_TYPE);
  assertEquals(data.layer, CAMPAIGN_PUSH_LAYER);
  assertEquals(data.channelId, CAMPAIGN_ANDROID_CHANNEL_ID);
  assertEquals(data.gradientFrom, "#166534");
  assertEquals(data.ctaLabel, "See Details");
  assertEquals(data.screen, "/promotions/eid");
  const noCta = buildCampaignHeadsUpFcmData({
    campaignId: "c1",
    notificationId: "n1",
    title: "Eid Mubarak",
    subtitle: "Warm wishes",
  });
  assertEquals(noCta.screen, "");
  assertEquals(noCta.deepLink, "");
  const taxi = buildCampaignHeadsUpFcmData({
    campaignId: "c-taxi",
    notificationId: "n-taxi",
    title: "Welcome 🚖",
    subtitle: "Ride with 🚖 today",
    emoji: "🚖",
  });
  assertEquals(taxi.title, "Welcome ✨");
  assertEquals(taxi.subtitle, "Ride with ✨ today");
  assertEquals(taxi.emoji, "✨");
  assertEquals(campaignTargetApps("both"), ["customer", "driver"]);
  assertEquals(campaignTargetApps("driver"), ["driver"]);
  assertEquals(campaignTargetApps("customer"), ["customer"]);
  assertEquals(normalizeCampaignPushPlatform("iPhone OS"), "ios");
  assertEquals(normalizeCampaignPushPlatform("ANDROID"), "android");
});

Deno.test("scheduled / repeat due helpers", () => {
  const now = new Date("2026-09-01T10:00:00.000Z");
  assertEquals(
    campaignIsDueAt(now, {
      status: "scheduled",
      schedule_mode: "scheduled",
      scheduled_at: "2026-09-01T09:59:00.000Z",
      starts_at: null,
      ends_at: null,
    }),
    true,
  );
  assertEquals(
    campaignIsDueAt(now, {
      status: "draft",
      schedule_mode: "instant",
      scheduled_at: "2026-09-01T09:59:00.000Z",
      starts_at: null,
      ends_at: null,
    }),
    false,
  );
  const nextYear = nextRepeatScheduledAt("repeat_yearly", now);
  assertEquals(nextYear?.toISOString(), "2027-09-01T10:00:00.000Z");
  const drifted = nextRepeatDueAfter(
    "repeat_yearly",
    new Date("2026-09-01T00:00:00.000Z"),
    new Date("2026-09-01T00:01:30.000Z"),
  );
  assertEquals(drifted?.toISOString(), "2027-09-01T00:00:00.000Z");
  const skippedMonths = nextRepeatDueAfter(
    "repeat_monthly",
    new Date("2026-01-15T08:00:00.000Z"),
    new Date("2026-04-01T08:00:00.000Z"),
  );
  assertEquals(skippedMonths?.toISOString(), "2026-04-15T08:00:00.000Z");
  assertEquals(
    campaignDeliveryDedupeKey({
      campaignId: "c1",
      userId: "u1",
      app: "customer",
      occurrenceAt: "2026-09-01T00:00:00.000Z",
    }),
    "c1:u1:customer:2026-09-01T00:00:00.000Z",
  );
  assertEquals(
    campaignDeliveryDedupeKey({
      campaignId: "c1",
      userId: "u1",
      app: "customer",
      occurrenceAt: null,
    }),
    "c1:u1:customer",
  );
});

Deno.test("send-campaign-heads-up lock", async () => {
  const src = await read("supabase/functions/send-campaign-heads-up/index.ts");
  const payload = await read("supabase/functions/_shared/campaignHeadsUpPayload.ts");
  const audience = await read("supabase/functions/_shared/campaignHeadsUpAudience.ts");
  const cron = await read(
    "supabase/migrations/20261027120000_campaign_heads_up_due_sweep_cron.sql",
  );
  const adminUi = await read("src/components/notifications/CampaignHeadsUpSection.tsx");

  const occurrenceUnique = await read(
    "supabase/migrations/20261027121000_campaign_heads_up_delivery_occurrence_unique.sql",
  );
  const claimedAtMigration = await read(
    "supabase/migrations/20261027122000_campaign_heads_up_delivery_claimed_at.sql",
  );
  const staleSendingSweep = await read(
    "supabase/migrations/20261027123000_campaign_heads_up_stale_sending_sweep.sql",
  );
  const templatesReadLock = await read(
    "supabase/migrations/20261027124000_campaign_heads_up_templates_read_lock.sql",
  );
  const deliveryUserUpdateGuard = await read(
    "supabase/migrations/20261027125000_campaign_heads_up_delivery_user_update_guard.sql",
  );

  const taxiBrandingSweep = await read(
    "supabase/migrations/20261028140000_campaign_heads_up_remove_taxi_branding.sql",
  );
  const sharedTemplates = await read("shared/campaignHeadsUpTemplates.ts");

  assert(src.includes("listActiveCustomerUserIds"));
  assert(src.includes("listActiveDriverIds"));
  assert(src.includes("assertCronOrServiceRoleAuth"));
  assert(src.includes('source === "pg_cron"'));
  assert(src.includes('sound: "default"'));
  assert(src.includes("normalizeCampaignPushPlatform"));
  assert(src.includes("campaignIsDueAt"));
  assert(src.includes("nextRepeatDueAfter"));
  assert(src.includes("dueToSend"));
  assert(src.includes("campaignDeliveryDedupeKey"));
  assert(src.includes("claimCampaignDelivery"));
  assert(src.includes("CAMPAIGN_SEND_HEARTBEAT_MS"));
  assert(src.includes("CAMPAIGN_STALE_SENDING_MS"));
  assert(src.includes("staleSending"));
  assert(src.includes('eq("status", "sending")'));
  assert(src.includes("heartbeatSending"));
  assert(src.includes('claim === "skip_done"'));
  assert(src.includes('claim === "skip_busy"'));
  // OS notification title/body must use scrubbed FCM payload fields, not raw DB copy.
  assert(src.includes("dataPayload.title"));
  assert(src.includes("dataPayload.subtitle"));
  assert(src.includes("return { sent: 0, delivered: 0, failed: 0 }"));
  assert(src.includes('.lt("claimed_at", staleBefore)'));
  assert(src.includes('.eq("status", "failed")'));
  assert(!src.includes('onConflict: "dedupe_key"'));
  assert(!src.includes('onConflict: "campaign_id,user_id,user_app"'));
  assert(src.includes("dueToSend.length === 0"));
  assert(src.includes('.lte("updated_at"'));
  assert(src.includes("nextExpired"));
  assert(audience.includes("target_user_segment is not supported"));
  assert(audience.includes("normalizeCampaignTargetUserIds"));
  assert(audience.includes("filterCampaignUserIdsForTargetApp"));
  assert(audience.includes("No matching users for target app"));
  assert(src.includes("noReachThisRun"));
  assert(src.includes("noReach: true"));
  assert(src.includes("revertStatus"));
  assert(src.includes('.in("status", ["pending", "failed"])'));
  assert(src.includes('priority: campaign.priority'));
  assert(!src.includes('invoke("send-trip-notification"'));
  assert(!src.includes("from \"../send-trip-notification"));
  assert(src.includes("buildCampaignHeadsUpFcmData"));
  assert(src.includes("resolveCampaignAudience"));
  assert(src.includes("resolveCustomerAuthoritativeToken"));
  assert(src.includes("resolveDriverAuthoritativeToken"));
  assert(src.includes("readCampaignFcmServiceAccountJson"));
  assert(src.includes("FCM_NOT_CONFIGURED"));
  assert(src.includes('deactivateInvalidPushToken'));
  assert(src.includes('.delete().eq("token", token)'));
  assert(!src.includes('from(table).delete()'));
  assert(!src.includes("eq(\"id\", row.id)"));
  // Never mark delivered when FCM credentials are missing.
  assert(!/if \(!accessToken \|\| !fcmProject\)[\s\S]{0,180}status: "delivered"/.test(src));

  assert(payload.includes('CAMPAIGN_PUSH_TYPE = "campaign_heads_up"'));
  assert(payload.includes('CAMPAIGN_ANDROID_CHANNEL_ID = "promotions"'));
  assert(audience.includes("resolveDriverIdsForAudience"));
  assert(audience.includes("resolveCustomerUserIdsForAudience"));
  assert(audience.includes("drivers.service_area_id"));
  assert(audience.includes('.eq("region_id"'));
  assert(audience.includes(".range(from, from + page - 1)"));
  assert(audience.includes('.gte("created_at", since)'));
  assert(audience.includes('.order("id", { ascending: true })'));
  assert(occurrenceUnique.includes("campaign_heads_up_deliveries_dedupe_key_uidx"));
  assert(claimedAtMigration.includes("claimed_at"));
  assert(staleSendingSweep.includes("status = 'sending'"));
  assert(staleSendingSweep.includes("interval '15 minutes'"));
  assert(templatesReadLock.includes("Admin or staff read campaign templates"));
  assert(templatesReadLock.includes("has_role"));
  assert(deliveryUserUpdateGuard.includes("enforce_campaign_heads_up_delivery_user_update"));
  assert(deliveryUserUpdateGuard.includes("campaign_heads_up_delivery_immutable_fields"));
  assert(deliveryUserUpdateGuard.includes("campaign_heads_up_delivery_invalid_stamps"));
  assert(deliveryUserUpdateGuard.includes("IF auth.uid() IS NULL THEN"));
  assert(deliveryUserUpdateGuard.includes("status IN ('opened', 'tapped', 'dismissed')"));
  // Bypass must be auth.uid() IS NULL — never auth.role() (comment may mention it).
  assert(!/\bIF\s+auth\.role\(\)/.test(deliveryUserUpdateGuard));
  assert(!/auth\.role\(\)\s*=/.test(deliveryUserUpdateGuard));
  assert(cron.includes("campaign_heads_up_due_sweep"));
  assert(cron.includes("'source', 'pg_cron'"));
  assert(adminUi.includes("insertStatus"));
  assert(adminUi.includes("invokeCampaignSend"));
  assert(adminUi.includes("created_by"));
  assert(adminUi.includes("toIsoOrNull"));
  assert(adminUi.includes("Select a region"));
  assert(adminUi.includes('isTimed ? "Schedule" : "Send Now"'));
  assert(adminUi.includes("auth user, customer, or driver UUIDs"));
  assert(adminUi.includes("noReach"));
  assert(adminUi.includes("campaignSendToast"));
  assert(adminUi.includes("kept as draft/scheduled"));
  assert(adminUi.includes('c.status === "sending"'));
  assert(adminUi.includes('"Retry"'));
  assert(adminUi.includes("onecab-notification-brand-mark.png"));
  assert(adminUi.includes("brandMark"));
  assert(adminUi.includes("scrubCampaignTaxiBranding"));
  assert(adminUi.includes("replaceCampaignTaxiBranding"));
  assert(sharedTemplates.includes("scrubCampaignTaxiBranding"));
  assert(sharedTemplates.includes("replaceCampaignTaxiBranding"));
  assert(sharedTemplates.includes("CAMPAIGN_TAXI_BRANDING_EMOJI"));
  assert(payload.includes("scrubCampaignTaxiBranding"));
  assert(!adminUi.includes("🚖"));
  // Seed catalog must not use taxi branding; the scrub constant may mention it.
  assert(!/title:\s*'[^']*🚖/.test(sharedTemplates));
  assert(!/emoji:\s*'🚖'/.test(sharedTemplates));
  assert(sharedTemplates.includes("Welcome to ONECAB ✨"));
  assert(taxiBrandingSweep.includes("replace(title, '🚖', '✨')"));
  assert(taxiBrandingSweep.includes("campaign_heads_up_templates"));
  assert(taxiBrandingSweep.includes("campaign_heads_up_campaigns"));
  const taxiSubtitleSweep = await read(
    "supabase/migrations/20261028150000_campaign_heads_up_scrub_subtitle_taxi.sql",
  );
  assert(taxiSubtitleSweep.includes("subtitle = replace(subtitle, '🚖', '✨')"));
  assert(taxiSubtitleSweep.includes("emoji = replace(coalesce(emoji, ''), '🚖', '✨')"));
  const taxiScrubTrigger = await read(
    "supabase/migrations/20261028160000_campaign_heads_up_taxi_scrub_trigger.sql",
  );
  assert(taxiScrubTrigger.includes("scrub_campaign_heads_up_taxi_branding"));
  assert(taxiScrubTrigger.includes("trg_scrub_campaign_heads_up_templates_taxi"));
  assert(taxiScrubTrigger.includes("trg_scrub_campaign_heads_up_campaigns_taxi"));
  assert(taxiScrubTrigger.includes("BEFORE INSERT OR UPDATE OF title, subtitle, emoji"));
  assert(adminUi.includes("scrubCampaignTaxiBranding(t.title)"));
  assert(!adminUi.includes("User segment"));
  assert(!payload.includes('|| "/offers"'));
});
