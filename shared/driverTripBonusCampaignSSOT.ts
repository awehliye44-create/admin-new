/**
 * Driver trip-bonus campaigns SSOT — Admin-controlled progress campaigns by service area.
 * Distinct from partner Special Offers (gold banner content feed).
 * Completion credits reuse driver_wallet_ledger type BONUS (existing payout path).
 */

export type TripBonusScopeType = "selected_service_areas" | "entire_region" | "global";

export const TRIP_BONUS_SCOPE_TYPES: TripBonusScopeType[] = [
  "selected_service_areas",
  "entire_region",
  "global",
];

export type TripBonusCampaignStatus = "draft" | "published" | "archived";

export interface DriverTripBonusCampaignRow {
  id: string;
  title: string;
  card_headline: string;
  card_body: string | null;
  trip_target: number;
  bonus_amount_pence: number;
  status: TripBonusCampaignStatus;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  scope_type: TripBonusScopeType;
  region_id: string | null;
  display_priority: number;
  created_at?: string | null;
}

export interface DriverTripBonusGeoContext {
  service_area_id: string | null;
  service_area_active: boolean;
  region_id: string | null;
}

export interface DriverTripBonusProgressView {
  campaign_id: string;
  title: string;
  card_headline: string;
  card_body: string | null;
  trip_target: number;
  completed_count: number;
  remaining_trips: number;
  bonus_amount_pence: number;
  credited: boolean;
  progress_ratio: number;
}

export const TRIP_BONUS_PAGE_SLUG = "driver-trip-bonuses";
export const TRIP_BONUS_LEDGER_TYPE = "BONUS";
export const TRIP_BONUS_LEDGER_DESCRIPTION_PREFIX = "Trip bonus:";

export function isCampaignLive(
  campaign: Pick<
    DriverTripBonusCampaignRow,
    "status" | "is_active" | "starts_at" | "ends_at"
  >,
  now: Date = new Date(),
): boolean {
  if (campaign.status !== "published") return false;
  if (!campaign.is_active) return false;
  const t = now.getTime();
  if (campaign.starts_at && new Date(campaign.starts_at).getTime() > t) return false;
  if (campaign.ends_at && new Date(campaign.ends_at).getTime() <= t) return false;
  return true;
}

export function matchesCampaignScope(
  campaign: Pick<DriverTripBonusCampaignRow, "scope_type" | "region_id">,
  driver: DriverTripBonusGeoContext,
  assignedAreaIds: string[],
): boolean {
  if (campaign.scope_type === "global") return true;
  if (!driver.service_area_id || !driver.service_area_active) return false;
  if (campaign.scope_type === "entire_region") {
    if (!campaign.region_id) return false;
    return driver.region_id === campaign.region_id;
  }
  return assignedAreaIds.includes(driver.service_area_id);
}

/** Higher display_priority first, then newer created_at, then id. */
export function sortCampaignsByHomePriority<
  T extends { id: string; display_priority: number; created_at?: string | null },
>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.display_priority !== b.display_priority) {
      return b.display_priority - a.display_priority;
    }
    const at = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (at !== bt) return bt - at;
    return a.id.localeCompare(b.id);
  });
}

export function selectHomeCampaign(
  campaigns: DriverTripBonusCampaignRow[],
  areaMap: Record<string, string[]>,
  driver: DriverTripBonusGeoContext,
  now: Date = new Date(),
): DriverTripBonusCampaignRow | null {
  const live = campaigns.filter(
    (c) =>
      isCampaignLive(c, now) &&
      matchesCampaignScope(c, driver, areaMap[c.id] ?? []),
  );
  const sorted = sortCampaignsByHomePriority(live);
  return sorted[0] ?? null;
}

export function buildProgressView(
  campaign: DriverTripBonusCampaignRow,
  completedCount: number,
  credited: boolean,
): DriverTripBonusProgressView {
  const target = Math.max(1, Math.floor(campaign.trip_target));
  const completed = Math.max(0, Math.floor(completedCount));
  const remaining = Math.max(0, target - completed);
  return {
    campaign_id: campaign.id,
    title: campaign.title,
    card_headline: campaign.card_headline,
    card_body: campaign.card_body,
    trip_target: target,
    completed_count: completed,
    remaining_trips: remaining,
    bonus_amount_pence: Math.max(0, Math.floor(campaign.bonus_amount_pence)),
    credited,
    progress_ratio: Math.min(1, completed / target),
  };
}

export function shouldCreditBonus(args: {
  completedCount: number;
  tripTarget: number;
  alreadyCredited: boolean;
  bonusAmountPence: number;
}): boolean {
  if (args.alreadyCredited) return false;
  if (args.bonusAmountPence <= 0) return false;
  return args.completedCount >= Math.max(1, Math.floor(args.tripTarget));
}

export function bonusLedgerDescription(campaignTitle: string): string {
  const title = campaignTitle.trim() || "Trip bonus";
  return `${TRIP_BONUS_LEDGER_DESCRIPTION_PREFIX} ${title}`.slice(0, 240);
}

export function validateCampaignDraft(input: {
  title: string;
  card_headline: string;
  trip_target: number;
  bonus_amount_pence: number;
  scope_type: TripBonusScopeType;
  region_id: string | null;
  service_area_ids: string[];
}): string[] {
  const errors: string[] = [];
  if (!input.title.trim()) errors.push("title_required");
  if (!input.card_headline.trim()) errors.push("card_headline_required");
  if (!Number.isFinite(input.trip_target) || input.trip_target < 1) {
    errors.push("trip_target_min_1");
  }
  if (!Number.isFinite(input.bonus_amount_pence) || input.bonus_amount_pence < 1) {
    errors.push("bonus_amount_min_1");
  }
  if (input.scope_type === "entire_region" && !input.region_id) {
    errors.push("region_required");
  }
  if (
    input.scope_type === "selected_service_areas" &&
    (!input.service_area_ids || input.service_area_ids.length === 0)
  ) {
    errors.push("service_areas_required");
  }
  if (input.scope_type === "global" && input.region_id) {
    errors.push("global_must_clear_region");
  }
  return errors;
}
