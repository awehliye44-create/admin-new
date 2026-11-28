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

export type TripBonusSettlementStatus =
  | "in_progress"
  | "credit_pending"
  | "credited";

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
  settlement_status: TripBonusSettlementStatus;
  progress_ratio: number;
}

export const TRIP_BONUS_PAGE_SLUG = "driver-trip-bonuses";
export const TRIP_BONUS_LEDGER_TYPE = "BONUS";
export const TRIP_BONUS_LEDGER_DESCRIPTION_PREFIX = "Trip bonus:";
export const TRIP_BONUS_LEDGER_SOURCE = "driver_trip_bonus_campaign";
export const TRIP_BONUS_CREDIT_PENDING_BODY = "Bonus earned — payment pending";

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

export function resolveParticipantSettlementStatus(args: {
  completedCount: number;
  tripTarget: number;
  credited: boolean;
}): TripBonusSettlementStatus {
  if (args.credited) return "credited";
  if (args.completedCount >= Math.max(1, Math.floor(args.tripTarget))) {
    return "credit_pending";
  }
  return "in_progress";
}

export function buildProgressView(
  campaign: DriverTripBonusCampaignRow,
  completedCount: number,
  credited: boolean,
  entitlement?: {
    trip_target?: number | null;
    bonus_amount_pence?: number | null;
  },
): DriverTripBonusProgressView {
  const target = Math.max(
    1,
    Math.floor(entitlement?.trip_target ?? campaign.trip_target),
  );
  const completed = Math.max(0, Math.floor(completedCount));
  const remaining = Math.max(0, target - completed);
  const settlement = resolveParticipantSettlementStatus({
    completedCount: completed,
    tripTarget: target,
    credited,
  });
  const bonus = Math.max(
    0,
    Math.floor(entitlement?.bonus_amount_pence ?? campaign.bonus_amount_pence),
  );
  return {
    campaign_id: campaign.id,
    title: campaign.title,
    card_headline: campaign.card_headline,
    card_body:
      settlement === "credit_pending"
        ? TRIP_BONUS_CREDIT_PENDING_BODY
        : campaign.card_body,
    trip_target: target,
    completed_count: completed,
    remaining_trips: remaining,
    bonus_amount_pence: bonus,
    credited,
    settlement_status: settlement,
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

/** Keep credit-pending cards visible after ends_at; hide only when credited. */
export function shouldHideTripBonusHomeCard(args: {
  settlementStatus: TripBonusSettlementStatus;
  endsAt: string | null | undefined;
  nowMs?: number;
}): boolean {
  if (args.settlementStatus === "credited") return true;
  if (args.settlementStatus === "credit_pending") return false;
  if (!args.endsAt) return false;
  const end = Date.parse(args.endsAt);
  if (!Number.isFinite(end)) return false;
  return end <= (args.nowMs ?? Date.now());
}

export function formatTripBonusCreditHeadsUp(bonusAmountPence: number): {
  title: string;
  subtitle: string;
} {
  const pounds = (Math.max(0, bonusAmountPence) / 100).toFixed(
    bonusAmountPence % 100 === 0 ? 0 : 2,
  );
  return {
    title: "Congratulations!",
    subtitle: `Your £${pounds} bonus has been added to your wallet.`,
  };
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

/**
 * Publish overlap SSOT (mirrored by SQL:
 * driver_trip_bonus_campaign_windows_overlap /
 * driver_trip_bonus_campaign_scopes_overlap in
 * 20270226210000_driver_trip_bonus_publish_overlap_guard.sql).
 *
 * Rules (must stay aligned Admin ↔ SQL):
 * - Only published + is_active campaigns participate (draft/archived/inactive ignored).
 * - Date windows: half-open [start, end); null start = -∞; null end = +∞.
 * - Scope: global overlaps all; entire_region ↔ same region_id; selected SAs ↔
 *   intersecting SA ids; entire_region ↔ selected if any selected SA.region_id
 *   matches (SA active flag ignored — membership by id, same as SQL).
 * Home shows one banner (selectHomeCampaign); overlapping publish is forbidden so
 * a driver cannot earn a campaign they cannot see.
 */

/** Half-open style window overlap: [start, end). Null start = -∞, null end = +∞. */
export function campaignWindowsOverlap(
  a: Pick<DriverTripBonusCampaignRow, "starts_at" | "ends_at">,
  b: Pick<DriverTripBonusCampaignRow, "starts_at" | "ends_at">,
): boolean {
  const aStart = a.starts_at ? new Date(a.starts_at).getTime() : Number.NEGATIVE_INFINITY;
  const aEnd = a.ends_at ? new Date(a.ends_at).getTime() : Number.POSITIVE_INFINITY;
  const bStart = b.starts_at ? new Date(b.starts_at).getTime() : Number.NEGATIVE_INFINITY;
  const bEnd = b.ends_at ? new Date(b.ends_at).getTime() : Number.POSITIVE_INFINITY;
  if (a.starts_at && !Number.isFinite(aStart)) return false;
  if (b.starts_at && !Number.isFinite(bStart)) return false;
  if (a.ends_at && !Number.isFinite(aEnd)) return false;
  if (b.ends_at && !Number.isFinite(bEnd)) return false;
  return aStart < bEnd && bStart < aEnd;
}

/**
 * True when two campaign scopes can match the same driver.
 * `serviceAreaRegionById` maps SA id → region id (needed for region vs SA compare).
 * When a selected SA id is missing from the map, treat region↔SA as overlapping
 * (fail closed) so Admin cannot under-detect vs SQL.
 */
export function campaignScopesCanMatchSameDriver(
  a: Pick<DriverTripBonusCampaignRow, "scope_type" | "region_id"> & {
    service_area_ids?: string[];
  },
  b: Pick<DriverTripBonusCampaignRow, "scope_type" | "region_id"> & {
    service_area_ids?: string[];
  },
  serviceAreaRegionById: Record<string, string | null | undefined> = {},
): boolean {
  if (a.scope_type === "global" || b.scope_type === "global") return true;

  if (a.scope_type === "entire_region" && b.scope_type === "entire_region") {
    return Boolean(a.region_id && a.region_id === b.region_id);
  }

  const aAreas = a.service_area_ids ?? [];
  const bAreas = b.service_area_ids ?? [];

  if (a.scope_type === "selected_service_areas" && b.scope_type === "selected_service_areas") {
    const setB = new Set(bAreas);
    return aAreas.some((id) => setB.has(id));
  }

  const regionVsAreas = (
    regionId: string | null,
    areas: string[],
  ): boolean => {
    if (!regionId || areas.length === 0) return false;
    for (const id of areas) {
      if (!(id in serviceAreaRegionById)) {
        // Unknown SA → fail closed (SQL resolves via service_areas table).
        return true;
      }
      if (serviceAreaRegionById[id] === regionId) return true;
    }
    return false;
  };

  if (a.scope_type === "entire_region" && b.scope_type === "selected_service_areas") {
    return regionVsAreas(a.region_id, bAreas);
  }
  if (b.scope_type === "entire_region" && a.scope_type === "selected_service_areas") {
    return regionVsAreas(b.region_id, aAreas);
  }
  return false;
}

export type TripBonusOverlapCandidate = DriverTripBonusCampaignRow & {
  service_area_ids?: string[];
};

/**
 * Find another published+active campaign that could credit the same driver while
 * Home only shows one card. Draft / inactive / archived are ignored.
 */
export function findOverlappingPublishedCampaign(
  candidate: TripBonusOverlapCandidate,
  existing: TripBonusOverlapCandidate[],
  serviceAreaRegionById: Record<string, string | null | undefined> = {},
): TripBonusOverlapCandidate | null {
  if (candidate.status !== "published" || !candidate.is_active) return null;
  for (const other of existing) {
    if (other.id === candidate.id) continue;
    if (other.status !== "published" || !other.is_active) continue;
    if (!campaignWindowsOverlap(candidate, other)) continue;
    if (
      !campaignScopesCanMatchSameDriver(candidate, other, serviceAreaRegionById)
    ) {
      continue;
    }
    return other;
  }
  return null;
}

/** Ledger description / source → trip-bonus (not generic promotions). */
export function isTripBonusLedgerDescription(description: string | null | undefined): boolean {
  const d = String(description ?? "").trim();
  return d.startsWith(TRIP_BONUS_LEDGER_DESCRIPTION_PREFIX);
}
