/**
 * Lock: trip-bonus financial integrity — entitlements, unique BONUS, reconcile,
 * credit-pending UX, freeze after participation.
 *
 * deno test --allow-read supabase/tests/_shared/driverTripBonusFinancialIntegrityLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";
import {
  buildProgressView,
  formatTripBonusCreditHeadsUp,
  resolveParticipantSettlementStatus,
  shouldCreditBonus,
  shouldHideTripBonusHomeCard,
  TRIP_BONUS_CREDIT_PENDING_BODY,
  TRIP_BONUS_LEDGER_SOURCE,
  TRIP_BONUS_LEDGER_TYPE,
  type DriverTripBonusCampaignRow,
} from "../../functions/_shared/driverTripBonusCampaignSSOT.ts";

const REPO = fromFileUrl(new URL("../../..", import.meta.url));
const INTEGRITY_MIG = "supabase/migrations/20261119161411_driver_trip_bonus_financial_integrity.sql";

function campaign(
  partial: Partial<DriverTripBonusCampaignRow> & { id: string },
): DriverTripBonusCampaignRow {
  return {
    title: "Milton Keynes 3-Trip Bonus",
    card_headline: "Complete 3 trips, earn £20",
    card_body: "Complete 3 eligible trips",
    trip_target: 3,
    bonus_amount_pence: 2000,
    status: "published",
    is_active: true,
    starts_at: null,
    ends_at: null,
    scope_type: "selected_service_areas",
    region_id: null,
    display_priority: 0,
    created_at: "2026-11-18T00:00:00Z",
    ...partial,
  };
}

Deno.test("1-2: two trips no credit; third qualifies", () => {
  assertEquals(
    shouldCreditBonus({
      completedCount: 2,
      tripTarget: 3,
      alreadyCredited: false,
      bonusAmountPence: 2000,
    }),
    false,
  );
  assertEquals(
    shouldCreditBonus({
      completedCount: 3,
      tripTarget: 3,
      alreadyCredited: false,
      bonusAmountPence: 2000,
    }),
    true,
  );
  assertEquals(
    resolveParticipantSettlementStatus({
      completedCount: 2,
      tripTarget: 3,
      credited: false,
    }),
    "in_progress",
  );
  assertEquals(
    resolveParticipantSettlementStatus({
      completedCount: 3,
      tripTarget: 3,
      credited: false,
    }),
    "credit_pending",
  );
});

Deno.test("3-4: already credited / fourth trip → no further credit", () => {
  assertEquals(
    shouldCreditBonus({
      completedCount: 4,
      tripTarget: 3,
      alreadyCredited: true,
      bonusAmountPence: 2000,
    }),
    false,
  );
  assertEquals(
    resolveParticipantSettlementStatus({
      completedCount: 4,
      tripTarget: 3,
      credited: true,
    }),
    "credited",
  );
});

Deno.test("7: credit-pending survives ends_at; credited hides", () => {
  assertEquals(
    shouldHideTripBonusHomeCard({
      settlementStatus: "credit_pending",
      endsAt: "2020-01-01T00:00:00Z",
    }),
    false,
  );
  assertEquals(
    shouldHideTripBonusHomeCard({
      settlementStatus: "in_progress",
      endsAt: "2020-01-01T00:00:00Z",
    }),
    true,
  );
  assertEquals(
    shouldHideTripBonusHomeCard({
      settlementStatus: "credited",
      endsAt: null,
    }),
    true,
  );
});

Deno.test("9: entitlement snapshot preferred over live campaign edits", () => {
  const view = buildProgressView(
    campaign({ id: "mk", trip_target: 10, bonus_amount_pence: 5000 }),
    2,
    false,
    { trip_target: 3, bonus_amount_pence: 2000 },
  );
  assertEquals(view.trip_target, 3);
  assertEquals(view.bonus_amount_pence, 2000);
  assertEquals(view.remaining_trips, 1);
  assertEquals(view.settlement_status, "in_progress");
});

Deno.test("12: credit heads-up uses dynamic reward; pending body locked", () => {
  const notice = formatTripBonusCreditHeadsUp(2000);
  assertEquals(notice.title, "Congratulations!");
  assertStringIncludes(notice.subtitle, "£20");
  assertStringIncludes(notice.subtitle, "wallet");
  const pending = buildProgressView(campaign({ id: "mk" }), 3, false, {
    trip_target: 3,
    bonus_amount_pence: 2000,
  });
  assertEquals(pending.card_body, TRIP_BONUS_CREDIT_PENDING_BODY);
  assertEquals(pending.settlement_status, "credit_pending");
});

Deno.test("migration: unique ledger + reconcile + freeze + entitlement columns", async () => {
  const mig = await Deno.readTextFile(join(REPO, INTEGRITY_MIG));
  assertStringIncludes(mig, "entitled_trip_target");
  assertStringIncludes(mig, "entitled_bonus_amount_pence");
  assertStringIncludes(mig, "driver_wallet_ledger_trip_bonus_campaign_uidx");
  assertStringIncludes(mig, "claim_or_reconcile_driver_trip_bonus_credit");
  assertStringIncludes(mig, "reconcile_driver_trip_bonus_qualified_credits");
  assertStringIncludes(mig, "in_window_not_applied");
  assertStringIncludes(mig, "trip_bonus_terms_frozen");
  assertStringIncludes(mig, "auto_reenqueue_dead_driver_trip_bonus_progress_outbox");
  assertStringIncludes(mig, "admin_driver_trip_bonus_campaign_finance_summary");
  assertStringIncludes(mig, "ack_driver_trip_bonus_credit_notice");
  assertStringIncludes(mig, TRIP_BONUS_LEDGER_TYPE);
  assertStringIncludes(mig, TRIP_BONUS_LEDGER_SOURCE);
  assertStringIncludes(mig, "FOR UPDATE");
  assertStringIncludes(mig, "unique_violation");
  // Preserve Welcome / non trip-bonus BONUS rows.
  assertStringIncludes(mig, "metadata->>'source' = 'driver_trip_bonus_campaign'");
});

Deno.test("Edge progress returns settlement + credit notice contract", async () => {
  const edge = await Deno.readTextFile(
    join(REPO, "supabase/functions/driver-trip-bonus-progress/index.ts"),
  );
  assertStringIncludes(edge, "settlement_status");
  assertStringIncludes(edge, "wallet_credit_notice");
  assertStringIncludes(edge, "reconcile_driver_trip_bonus_qualified_credits");
  assertStringIncludes(edge, "credit_pending");
});
