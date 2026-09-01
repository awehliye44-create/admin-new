/**
 * Campaign / Celebration Heads-Up (System B) — payload SSOT.
 * Completely separate from operational trip heads-up (System A).
 * Apps parse `type === campaign_heads_up` (layer === campaign).
 */

export const CAMPAIGN_PUSH_LAYER = "campaign";
export const CAMPAIGN_PUSH_TYPE = "campaign_heads_up";
export const CAMPAIGN_ANDROID_CHANNEL_ID = "promotions";
export const CAMPAIGN_IOS_CATEGORY = "campaign_heads_up";
export const CAMPAIGN_HEADS_UP_AUTO_DISMISS_MS = 4000;

export type CampaignTargetApp = "customer" | "driver" | "both";

export type CampaignHeadsUpVisualInput = {
  campaignId: string;
  notificationId: string;
  title: string;
  subtitle: string;
  emoji?: string | null;
  accentColor?: string | null;
  gradientFrom?: string | null;
  gradientTo?: string | null;
  backgroundImageUrl?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  deepLink?: string | null;
  priority?: string | null;
};

/** FCM data values must be strings. */
export function buildCampaignHeadsUpFcmData(
  input: CampaignHeadsUpVisualInput,
): Record<string, string> {
  const deepLink = (input.deepLink ?? input.ctaUrl ?? "").trim();
  const ctaUrl = (input.ctaUrl ?? input.deepLink ?? "").trim();
  return {
    layer: CAMPAIGN_PUSH_LAYER,
    type: CAMPAIGN_PUSH_TYPE,
    campaignId: input.campaignId,
    notificationId: input.notificationId,
    title: input.title,
    body: input.subtitle,
    subtitle: input.subtitle,
    emoji: input.emoji ?? "",
    accentColor: input.accentColor ?? "blue",
    gradientFrom: input.gradientFrom ?? "",
    gradientTo: input.gradientTo ?? "",
    backgroundImageUrl: input.backgroundImageUrl ?? "",
    ctaLabel: input.ctaLabel ?? "",
    ctaUrl,
    deepLink,
    screen: deepLink || ctaUrl,
    priority: (input.priority ?? "normal").trim() || "normal",
    channelId: CAMPAIGN_ANDROID_CHANNEL_ID,
  };
}

export function campaignDeliveryDedupeKey(opts: {
  campaignId: string;
  userId: string;
  app: string;
  occurrenceAt: string | null;
}): string {
  const base = `${opts.campaignId}:${opts.userId}:${opts.app}`;
  const occurrence = (opts.occurrenceAt ?? "").trim();
  return occurrence ? `${base}:${occurrence}` : base;
}

export function campaignTargetApps(
  targetApp: string | null | undefined,
): Array<"customer" | "driver"> {
  if (targetApp === "both") return ["customer", "driver"];
  if (targetApp === "driver") return ["driver"];
  return ["customer"];
}

export function campaignFcmAndroidPriority(
  priority: string | null | undefined,
): "HIGH" | "NORMAL" {
  return priority === "high" ? "HIGH" : "NORMAL";
}

export function campaignApnsPriority(
  priority: string | null | undefined,
): "10" | "5" {
  return priority === "high" ? "10" : "5";
}

/** Same secret names as incoming-call FCM — never require a separate FCM_PROJECT_ID. */
export function readCampaignFcmServiceAccountJson(): string | null {
  return (
    Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") ??
    Deno.env.get("FCM_SERVICE_ACCOUNT_JSON") ??
    Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON") ??
    null
  );
}

export function normalizeCampaignPushPlatform(
  platform: string | null | undefined,
): "ios" | "android" {
  const raw = (platform ?? "android").toLowerCase();
  return raw.includes("ios") || raw.includes("iphone") || raw.includes("ipad")
    ? "ios"
    : "android";
}

export function isRepeatCampaignScheduleMode(
  mode: string | null | undefined,
): boolean {
  return mode === "repeat_yearly" || mode === "repeat_monthly";
}

export type CampaignDueRow = {
  status: string | null;
  schedule_mode: string | null;
  scheduled_at: string | null;
  starts_at: string | null;
  ends_at: string | null;
};

export function campaignIsExpiredAt(now: Date, row: CampaignDueRow): boolean {
  if (!row.ends_at) return false;
  const ends = Date.parse(row.ends_at);
  return Number.isFinite(ends) && ends <= now.getTime();
}

/** One-shot scheduled + repeats that are due to fire. Instant drafts are never due. */
export function campaignIsDueAt(now: Date, row: CampaignDueRow): boolean {
  if ((row.status ?? "").trim() !== "scheduled") return false;
  if (campaignIsExpiredAt(now, row)) return false;
  const dueRaw = row.scheduled_at || row.starts_at;
  if (!dueRaw) return false;
  const due = Date.parse(dueRaw);
  return Number.isFinite(due) && due <= now.getTime();
}

export function nextRepeatScheduledAt(
  mode: string | null | undefined,
  from: Date,
): Date | null {
  if (mode === "repeat_yearly") {
    const next = new Date(from.getTime());
    next.setUTCFullYear(next.getUTCFullYear() + 1);
    return next;
  }
  if (mode === "repeat_monthly") {
    const next = new Date(from.getTime());
    next.setUTCMonth(next.getUTCMonth() + 1);
    return next;
  }
  return null;
}

/** Next occurrence after `now`, anchored to the original due instant (no cron drift). */
export function nextRepeatDueAfter(
  mode: string | null | undefined,
  originalDue: Date,
  now: Date,
): Date | null {
  let next = nextRepeatScheduledAt(mode, originalDue);
  if (!next) return null;
  let guard = 0;
  while (next.getTime() <= now.getTime() && guard < 240) {
    const advanced = nextRepeatScheduledAt(mode, next);
    if (!advanced) return null;
    next = advanced;
    guard += 1;
  }
  if (next.getTime() <= now.getTime()) return null;
  return next;
}
