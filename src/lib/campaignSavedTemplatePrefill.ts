/**
 * Maps an admin-created template from the Notifications "Templates" tab
 * (notification_templates) into the Campaign / Celebration form fields.
 * Read-only reuse: the saved template stays the single copy of its text.
 */
import type { CampaignTargetApp } from "../../shared/campaignHeadsUpTemplates";

export interface SavedNotificationTemplate {
  id: string;
  name: string;
  category: string;
  title_template: string;
  message_template: string;
}

export interface SavedTemplatePrefill {
  emoji: string | null;
  title: string;
  subtitle: string;
  target_app: CampaignTargetApp | null;
}

const LEADING_EMOJI = /^\s*((?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\uFE0F|\u200D|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator})*)\s*/u;

const CATEGORY_TARGET_APP: Record<string, CampaignTargetApp> = {
  rider: "customer",
  driver: "driver",
};

export function savedTemplatePrefill(t: SavedNotificationTemplate): SavedTemplatePrefill {
  const rawTitle = (t.title_template ?? "").trim();
  const match = rawTitle.match(LEADING_EMOJI);
  const emoji = match ? match[1] : null;
  const title = match ? rawTitle.slice(match[0].length).trim() : rawTitle;
  return {
    emoji,
    title: title || rawTitle,
    subtitle: (t.message_template ?? "").trim(),
    target_app: CATEGORY_TARGET_APP[t.category] ?? null,
  };
}

export function savedTemplateHasPlaceholders(t: SavedNotificationTemplate): boolean {
  return /\{\{[^}]+\}\}/.test(`${t.title_template ?? ""} ${t.message_template ?? ""}`);
}
