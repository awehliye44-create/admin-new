/**
 * Lock: trip-bonus campaign scope, one Home card, double-credit guard.
 * deno test --allow-read supabase/tests/_shared/driverTripBonusCampaignLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";
import {
  buildProgressView,
  bonusLedgerDescription,
  isCampaignLive,
  matchesCampaignScope,
  selectHomeCampaign,
  shouldCreditBonus,
  TRIP_BONUS_LEDGER_TYPE,
  validateCampaignDraft,
  type DriverTripBonusCampaignRow,
} from "../../functions/_shared/driverTripBonusCampaignSSOT.ts";

const REPO = fromFileUrl(new URL("../../..", import.meta.url));

function campaign(
  partial: Partial<DriverTripBonusCampaignRow> & { id: string },
): DriverTripBonusCampaignRow {
  return {
    title: "Complete 10 trips",
    card_headline: "10 trips → £20",
    card_body: null,
    trip_target: 10,
    bonus_amount_pence: 2000,
    status: "published",
    is_active: true,
    starts_at: null,
    ends_at: null,
    scope_type: "selected_service_areas",
    region_id: null,
    display_priority: 0,
    created_at: "2026-11-01T00:00:00Z",
    ...partial,
  };
}

Deno.test("live window requires published + active", () => {
  assertEquals(isCampaignLive(campaign({ id: "a", status: "draft" })), false);
  assertEquals(isCampaignLive(campaign({ id: "a", is_active: false })), false);
  assertEquals(isCampaignLive(campaign({ id: "a" })), true);
});

Deno.test("scope: selected SA / region / global", () => {
  const geo = {
    service_area_id: "sa-1",
    service_area_active: true,
    region_id: "reg-1",
  };
  assertEquals(
    matchesCampaignScope(campaign({ id: "a", scope_type: "global" }), geo, []),
    true,
  );
  assertEquals(
    matchesCampaignScope(
      campaign({ id: "a", scope_type: "entire_region", region_id: "reg-1" }),
      geo,
      [],
    ),
    true,
  );
  assertEquals(
    matchesCampaignScope(
      campaign({ id: "a", scope_type: "selected_service_areas" }),
      geo,
      ["sa-1"],
    ),
    true,
  );
  assertEquals(
    matchesCampaignScope(
      campaign({ id: "a", scope_type: "selected_service_areas" }),
      geo,
      ["sa-other"],
    ),
    false,
  );
});

Deno.test("Home card picks highest display_priority live campaign", () => {
  const rows = [
    campaign({ id: "low", display_priority: 1, created_at: "2026-11-02T00:00:00Z" }),
    campaign({ id: "high", display_priority: 5, created_at: "2026-11-01T00:00:00Z" }),
  ];
  const picked = selectHomeCampaign(
    rows,
    { low: ["sa-1"], high: ["sa-1"] },
    { service_area_id: "sa-1", service_area_active: true, region_id: "reg-1" },
  );
  assertEquals(picked?.id, "high");
});

Deno.test("double-credit forbidden once credited", () => {
  assertEquals(
    shouldCreditBonus({
      completedCount: 10,
      tripTarget: 10,
      alreadyCredited: true,
      bonusAmountPence: 2000,
    }),
    false,
  );
  assertEquals(
    shouldCreditBonus({
      completedCount: 10,
      tripTarget: 10,
      alreadyCredited: false,
      bonusAmountPence: 2000,
    }),
    true,
  );
  assertEquals(
    shouldCreditBonus({
      completedCount: 9,
      tripTarget: 10,
      alreadyCredited: false,
      bonusAmountPence: 2000,
    }),
    false,
  );
});

Deno.test("progress view remaining and ratio", () => {
  const view = buildProgressView(campaign({ id: "c", trip_target: 10 }), 4, false);
  assertEquals(view.remaining_trips, 6);
  assertEquals(view.progress_ratio, 0.4);
  assertEquals(view.credited, false);
});

Deno.test("draft validation + BONUS ledger type lock", async () => {
  assertEquals(
    validateCampaignDraft({
      title: "",
      card_headline: "x",
      trip_target: 0,
      bonus_amount_pence: 0,
      scope_type: "selected_service_areas",
      region_id: null,
      service_area_ids: [],
    }).length > 0,
    true,
  );
  assertEquals(TRIP_BONUS_LEDGER_TYPE, "BONUS");
  assertStringIncludes(bonusLedgerDescription("Summer 10"), "Trip bonus:");

  const mig = await Deno.readTextFile(
    join(REPO, "supabase/migrations/20270226180000_driver_trip_bonus_campaigns.sql"),
  );
  assertStringIncludes(mig, "driver_trip_bonus_campaigns");
  assertStringIncludes(mig, "driver_trip_bonus_campaign_progress");
  assertStringIncludes(mig, "'BONUS'");
  assertStringIncludes(mig, "driver-trip-bonuses");
});
