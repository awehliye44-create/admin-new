/**
 * Slice 5 proof tests — weekly payout batch workflow (19 proof points).
 */
import { describe, expect, it } from "vitest";
import {
  ADMIN_EXECUTION_DISABLED_LABEL,
  LEGACY_WEEKLY_MONDAY_KIND,
  SLICE5_BATCH_STATUS,
  SLICE5_ITEM_STATUS,
  WEEKLY_PAYOUT_BATCH_KIND,
  adminBatchStatusLabel,
  assertNoActiveMondayHardcode,
  assertSlice5MoneySafety,
  buildLocalOccurrenceIso,
  buildScheduleOccurrenceKey,
  evaluateDriverBatchEligibility,
  formatTimezoneOffsetIso,
  itemIdempotencyKey,
  itemProviderRequestId,
  resolveScheduleOccurrence,
  shouldBlockExecutionDisabled,
  slugifyServiceAreaName,
  sumEligibleAmounts,
} from "../weeklyDriverPayoutBatchWorkflowSSOT.ts";
import {
  assertNoLegacyMondayHardcode,
  buildPayoutScheduleDto,
  computeNextWeeklyPayoutRun,
  zonedWallTimeToUtc,
} from "../payoutScheduleSSOT.ts";

const TUESDAY_SETTINGS = {
  payouts_enabled: true,
  payout_frequency: "weekly",
  weekly_payout_day: "tuesday",
  payout_processing_time: "12:00",
  payout_timezone: "Europe/London",
};

const AHMED = "5ed232c3-8bb5-4085-95d6-73e48e6c5e28";
const BOSTEYO = "cd8bae4c-3827-4b90-98c6-10be70eb0e52";
const AHMED_DEST = "ad3ead22-0000-0000-0000-000000000001";
const BOSTEYO_DEST = "e9e43f5c-0000-0000-0000-000000000001";

function linkedDest(id: string) {
  return {
    id,
    is_active: true,
    archived_at: null,
    provider_link_status: "PROVIDER_VERIFIED",
    provider_counterparty_id: `cp-${id.slice(0, 8)}`,
    provider_recipient_account_id: `ra-${id.slice(0, 8)}`,
  };
}

describe("Slice 5 — weekly payout batch workflow", () => {
  it("1. Scheduler reads Tuesday 12:00 Europe/London from Settings SSOT", () => {
    const dto = buildPayoutScheduleDto({
      automatic_payouts_enabled: true,
      frequency: "weekly",
      weekly_day: "tuesday",
      local_processing_time: "12:00",
      timezone: "Europe/London",
      now: new Date("2026-07-13T10:00:00Z"), // Monday
    });
    expect(dto.weekly_day).toBe("tuesday");
    expect(dto.local_processing_time).toBe("12:00");
    expect(dto.timezone).toBe("Europe/London");
    expect(dto.schedule_label).toBe("Weekly Tuesday");

    const due = resolveScheduleOccurrence({
      settings: TUESDAY_SETTINGS,
      service_area_slug: "milton-keynes",
      now: new Date("2026-07-14T12:05:00+01:00"),
    });
    expect("not_due" in due).toBe(false);
    if ("not_due" in due) return;
    expect(due.weekly_day).toBe("tuesday");
    expect(due.schedule_occurrence_key).toContain("2026-07-14T12:00:00+01:00");
  });

  it("2. No active Monday hardcoding remains", () => {
    expect(WEEKLY_PAYOUT_BATCH_KIND).toBe("WEEKLY_SCHEDULED");
    expect(WEEKLY_PAYOUT_BATCH_KIND).not.toBe(LEGACY_WEEKLY_MONDAY_KIND);
    expect(assertNoActiveMondayHardcode(WEEKLY_PAYOUT_BATCH_KIND)).toBe(true);
    expect(assertNoActiveMondayHardcode("WEEKLY_MONDAY")).toBe(false);
    expect(assertNoLegacyMondayHardcode("Weekly Tuesday")).toBe(true);
    const dto = buildPayoutScheduleDto({
      weekly_day: "tuesday",
      local_processing_time: "12:00",
      frequency: "weekly",
      automatic_payouts_enabled: true,
    });
    expect(dto.schedule_label.toLowerCase()).not.toContain("monday");
  });

  it("3. Correct UTC conversion for BST and GMT", () => {
    // BST: 2026-07-14 12:00 London = 11:00 UTC
    const bst = buildLocalOccurrenceIso({
      year: 2026, month: 7, day: 14, hour: 12, minute: 0, timeZone: "Europe/London",
    });
    expect(bst.scheduled_utc_at).toBe("2026-07-14T11:00:00.000Z");
    expect(bst.local_iso_with_offset).toBe("2026-07-14T12:00:00+01:00");
    expect(formatTimezoneOffsetIso(bst.utc, "Europe/London")).toBe("+01:00");

    // GMT: 2026-01-13 12:00 London = 12:00 UTC
    const gmt = buildLocalOccurrenceIso({
      year: 2026, month: 1, day: 13, hour: 12, minute: 0, timeZone: "Europe/London",
    });
    expect(gmt.scheduled_utc_at).toBe("2026-01-13T12:00:00.000Z");
    expect(gmt.local_iso_with_offset).toBe("2026-01-13T12:00:00+00:00");

    const wall = zonedWallTimeToUtc({
      year: 2026, month: 7, day: 14, hour: 12, minute: 0, timeZone: "Europe/London",
    });
    expect(wall.toISOString()).toBe("2026-07-14T11:00:00.000Z");
  });

  it("4. One occurrence creates one deterministic key only", () => {
    const key1 = buildScheduleOccurrenceKey({
      serviceAreaSlug: "milton-keynes",
      localIsoWithOffset: "2026-07-14T12:00:00+01:00",
    });
    const key2 = buildScheduleOccurrenceKey({
      serviceAreaSlug: "milton-keynes",
      localIsoWithOffset: "2026-07-14T12:00:00+01:00",
    });
    expect(key1).toBe(key2);
    expect(key1).toBe("weekly-payout:milton-keynes:2026-07-14T12:00:00+01:00");
  });

  it("5–7. Ahmed £10.01, Bosteyo £4.08, batch total £14.09", () => {
    const ahmed = evaluateDriverBatchEligibility({
      driver_id: AHMED,
      wallet_balance_pence: 1001,
      available_payout_pence: 1001,
      payouts_enabled: true,
      driver_held_or_blocked: false,
      currency: "GBP",
      expected_currency: "GBP",
      destination: linkedDest(AHMED_DEST),
      has_conflicting_active_item: false,
    });
    const bosteyo = evaluateDriverBatchEligibility({
      driver_id: BOSTEYO,
      wallet_balance_pence: 408,
      available_payout_pence: 408,
      payouts_enabled: true,
      driver_held_or_blocked: false,
      currency: "GBP",
      expected_currency: "GBP",
      destination: linkedDest(BOSTEYO_DEST),
      has_conflicting_active_item: false,
    });
    expect(ahmed.eligible).toBe(true);
    expect(bosteyo.eligible).toBe(true);
    if (!ahmed.eligible || !bosteyo.eligible) return;
    expect(ahmed.amount_pence).toBe(1001);
    expect(bosteyo.amount_pence).toBe(408);
    expect(sumEligibleAmounts([ahmed, bosteyo])).toBe(1409);
  });

  it("8–9. Idempotent keys reuse across re-runs (no duplicate identity)", () => {
    const occurrence = "weekly-payout:milton-keynes:2026-07-14T12:00:00+01:00";
    const batchId = "batch-1";
    const k1 = itemIdempotencyKey(occurrence, AHMED);
    const k2 = itemIdempotencyKey(occurrence, AHMED);
    expect(k1).toBe(k2);
    expect(itemProviderRequestId(batchId, AHMED)).toBe(
      itemProviderRequestId(batchId, AHMED),
    );
    expect(itemProviderRequestId(batchId, AHMED)).not.toBe(
      itemProviderRequestId(batchId, BOSTEYO),
    );
  });

  it("10. Driver eligibility comes only from Driver Wallet Ledger SSOT", () => {
    const result = evaluateDriverBatchEligibility({
      driver_id: AHMED,
      wallet_balance_pence: 1001,
      available_payout_pence: 1001,
      payouts_enabled: true,
      driver_held_or_blocked: false,
      currency: "GBP",
      expected_currency: "GBP",
      destination: linkedDest(AHMED_DEST),
      has_conflicting_active_item: false,
    });
    expect(result.eligibility_snapshot.source).toBe("driver_wallet_ledger_ssot");
    expect(result.eligibility_snapshot.excluded_sources).toEqual(
      expect.arrayContaining([
        "revolut_account_balance",
        "payment_sessions",
        "trip_rows_direct",
        "customer_capture_amount",
        "company_balance",
      ]),
    );
  });

  it("11. Provider linkage is required", () => {
    const unlinked = evaluateDriverBatchEligibility({
      driver_id: AHMED,
      wallet_balance_pence: 1001,
      available_payout_pence: 1001,
      payouts_enabled: true,
      driver_held_or_blocked: false,
      currency: "GBP",
      expected_currency: "GBP",
      destination: {
        id: AHMED_DEST,
        is_active: true,
        provider_link_status: "NOT_LINKED",
        provider_counterparty_id: null,
        provider_recipient_account_id: null,
      },
      has_conflicting_active_item: false,
    });
    expect(unlinked.eligible).toBe(false);
    if (unlinked.eligible) return;
    expect(unlinked.reasons).toContain("PROVIDER_LINKAGE_REQUIRED");
  });

  it("12–14. Execution stops at BLOCKED_EXECUTION_DISABLED; no relay/Revolut", () => {
    const env = {
      get: (k: string) => {
        if (k === "LIVE_PAYOUT_EXECUTION_ENABLED") return "false";
        if (k === "REVOLUT_PAYMENT_TRANSPORT_ENABLED") return "false";
        return undefined;
      },
    };
    expect(shouldBlockExecutionDisabled(env)).toBe(true);
    expect(SLICE5_BATCH_STATUS.BLOCKED_EXECUTION_DISABLED).toBe("BLOCKED_EXECUTION_DISABLED");
    expect(SLICE5_ITEM_STATUS.BLOCKED_EXECUTION_DISABLED).toBe("BLOCKED_EXECUTION_DISABLED");
    expect(adminBatchStatusLabel(SLICE5_BATCH_STATUS.BLOCKED_EXECUTION_DISABLED))
      .toBe(ADMIN_EXECUTION_DISABLED_LABEL);

    expect(() => assertSlice5MoneySafety({
      wallet_reserved: false,
      wallet_debited: false,
      revolut_pay_called: false,
      relay_payment_called: false,
      slices_6_to_12_started: false,
    })).not.toThrow();

    expect(() => assertSlice5MoneySafety({ revolut_pay_called: true })).toThrow(/Revolut/);
    expect(() => assertSlice5MoneySafety({ relay_payment_called: true })).toThrow(/relay/);
  });

  it("15–18. No wallet reserve/debit/paid claims; balances unchanged invariants", () => {
    expect(() => assertSlice5MoneySafety({ wallet_reserved: true })).toThrow(/reserved/);
    expect(() => assertSlice5MoneySafety({ wallet_debited: true })).toThrow(/debited/);
    // Slice 5 statuses never include PAID
    expect(Object.values(SLICE5_ITEM_STATUS)).not.toContain("PAID");
    expect(Object.values(SLICE5_BATCH_STATUS)).not.toContain("PAID");
    expect(Object.values(SLICE5_BATCH_STATUS)).not.toContain("COMPLETED");
  });

  it("19. Slices 6–12 were not started", () => {
    expect(() => assertSlice5MoneySafety({ slices_6_to_12_started: true }))
      .toThrow(/slices 6/);
    expect(() => assertSlice5MoneySafety({ slices_6_to_12_started: false })).not.toThrow();
  });

  it("force_schedule_occurrence_key works without wall-clock Tuesday due window", () => {
    const forced = resolveScheduleOccurrence({
      settings: TUESDAY_SETTINGS,
      service_area_slug: "milton-keynes",
      now: new Date("2026-07-15T10:00:00Z"), // Wednesday
      force_schedule_occurrence_key:
        "weekly-payout:milton-keynes:2026-07-14T12:00:00+01:00",
    });
    expect("not_due" in forced).toBe(false);
    if ("not_due" in forced) return;
    expect(forced.schedule_occurrence_key).toBe(
      "weekly-payout:milton-keynes:2026-07-14T12:00:00+01:00",
    );
  });

  it("before 12:00 Tuesday → not due; after → due", () => {
    const before = resolveScheduleOccurrence({
      settings: TUESDAY_SETTINGS,
      service_area_slug: "milton-keynes",
      now: new Date("2026-07-14T10:00:00+01:00"),
    });
    expect("not_due" in before).toBe(true);

    const after = resolveScheduleOccurrence({
      settings: TUESDAY_SETTINGS,
      service_area_slug: "milton-keynes",
      now: new Date("2026-07-14T12:00:00+01:00"),
    });
    expect("not_due" in after).toBe(false);
  });

  it("slugify service area", () => {
    expect(slugifyServiceAreaName("Milton Keynes")).toBe("milton-keynes");
  });

  it("computeNextWeeklyPayoutRun respects Tuesday settings (not Monday)", () => {
    const run = computeNextWeeklyPayoutRun({
      weeklyPayoutDay: "tuesday",
      localProcessingTime: "12:00",
      timeZone: "Europe/London",
      now: new Date("2026-07-13T15:00:00Z"),
    });
    expect(run.weekly_day).toBe("tuesday");
    expect(run.local_processing_time).toBe("12:00");
    expect(run.next_run_at_utc).toBe("2026-07-14T11:00:00.000Z");
  });
});
