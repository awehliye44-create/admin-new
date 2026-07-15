import { describe, expect, it } from "vitest";
import {
  buildPayoutScheduleDto,
  buildPayoutScheduleLabel,
  computeNextWeeklyPayoutRun,
  resolvePayoutTimezone,
  zonedWallTimeToUtc,
} from "../payoutScheduleSSOT";
import {
  computeCompanyAvailableForTransferPence,
  resolveCompanyBalanceSnapshot,
  COMPANY_BALANCE_ERROR,
} from "../companyBalanceSSOT";

describe("payout schedule SSOT", () => {
  it("builds Weekly Tuesday label from control-centre day", () => {
    expect(buildPayoutScheduleLabel({ frequency: "weekly", weeklyDay: "tuesday" })).toBe("Weekly Tuesday");
    expect(buildPayoutScheduleLabel({ frequency: "weekly", weeklyDay: "monday" })).toBe("Weekly Monday");
  });

  it("resolves GBP UTC service areas to Europe/London", () => {
    expect(resolvePayoutTimezone({ serviceAreaTimezone: "UTC", currencyCode: "GBP" })).toBe("Europe/London");
    expect(resolvePayoutTimezone({ serviceAreaTimezone: "Europe/London", currencyCode: "GBP" })).toBe("Europe/London");
  });

  it("computes next Tuesday 12:00 Europe/London (not Monday 01:00)", () => {
    // Sunday 12 Jul 2026 15:00 UTC → next run Tuesday 14 Jul 2026 12:00 London = 11:00 UTC (BST)
    const now = new Date("2026-07-12T15:00:00.000Z");
    const run = computeNextWeeklyPayoutRun({
      weeklyPayoutDay: "tuesday",
      localProcessingTime: "12:00",
      timeZone: "Europe/London",
      now,
    });
    expect(run.next_run_at_utc).toBe("2026-07-14T11:00:00.000Z");
    expect(run.next_run_at_local.toLowerCase()).toContain("tuesday");
    expect(run.next_run_at_local).toContain("12:00");
    expect(run.next_run_at_local).not.toContain("01:00");
  });

  it("uses today when still before processing time on payout day", () => {
    // Tuesday 14 Jul 2026 08:00 London = 07:00 UTC
    const now = new Date("2026-07-14T07:00:00.000Z");
    const run = computeNextWeeklyPayoutRun({
      weeklyPayoutDay: "tuesday",
      localProcessingTime: "12:00",
      timeZone: "Europe/London",
      now,
    });
    expect(run.next_run_at_utc).toBe("2026-07-14T11:00:00.000Z");
  });

  it("DTO exposes schedule_label Weekly Tuesday and 12:00", () => {
    const dto = buildPayoutScheduleDto({
      weekly_day: "tuesday",
      local_processing_time: "12:00",
      frequency: "weekly",
      currencyCode: "GBP",
      serviceAreaTimezone: "UTC",
      now: new Date("2026-07-12T15:00:00.000Z"),
    });
    expect(dto.schedule_label).toBe("Weekly Tuesday");
    expect(dto.local_processing_time).toBe("12:00");
    expect(dto.timezone).toBe("Europe/London");
    expect(dto.next_run_at_utc).toBe("2026-07-14T11:00:00.000Z");
  });

  it("DTO without weekly_day is MISCONFIGURED — never Weekly Monday", () => {
    const dto = buildPayoutScheduleDto({
      frequency: "weekly",
      local_processing_time: "12:00",
      currencyCode: "GBP",
      serviceAreaTimezone: "Europe/London",
    });
    expect(dto.schedule_status).toBe("MISCONFIGURED");
    expect(dto.schedule_label).toBe("Schedule not configured");
    expect(dto.schedule_label.toLowerCase()).not.toContain("monday");
  });

  it("DST: winter Tuesday 12:00 London is 12:00 UTC", () => {
    const utc = zonedWallTimeToUtc({
      year: 2026,
      month: 1,
      day: 13, // Tuesday
      hour: 12,
      minute: 0,
      timeZone: "Europe/London",
    });
    expect(utc.toISOString()).toBe("2026-01-13T12:00:00.000Z");
  });
});

describe("company available formula", () => {
  it("excludes protected driver liabilities from company available", () => {
    // eligible = 10000-1409-500 = 8091; classified = eligible → final = 7991
    const eligible = 10_000 - 1_409 - 500;
    expect(computeCompanyAvailableForTransferPence({
      provider_available_balance_pence: 10_000,
      driver_liability_pence: 1_409,
      driver_payout_reserved_pence: 0,
      customer_refund_reserved_pence: 0,
      approved_company_payables_pence: 500,
      operational_reserve_pence: 100,
      classified_company_cash_pence: eligible,
    })).toBe(eligible - 100);
  });

  it("fail-closed when operational reserve is NOT_CONFIGURED", () => {
    expect(computeCompanyAvailableForTransferPence({
      provider_available_balance_pence: 1526,
      driver_liability_pence: 1001,
      approved_company_payables_pence: 0,
      operational_reserve_pence: null,
      classified_company_cash_pence: 172,
    })).toBeNull();
  });

  it("never invents £0 when provider available is null", () => {
    expect(computeCompanyAvailableForTransferPence({
      provider_available_balance_pence: null,
      driver_liability_pence: 1409,
    })).toBeNull();
    const snap = resolveCompanyBalanceSnapshot({
      status_code: "AUTHENTICATION_REQUIRED",
      driver_liability_pence: 1409,
    });
    expect(snap.company_available_for_transfer_pence).toBeNull();
    expect(snap.unavailable_reason).toBe("AUTHENTICATION_REQUIRED");
    expect(snap.unavailable_reason).not.toBeNull();
  });

  it("rejects stub zero as company evidence", () => {
    const snap = resolveCompanyBalanceSnapshot({ provider_balance_is_stub: true });
    expect(snap.status).toBe("UNAVAILABLE");
    expect(snap.unavailable_reason).toBe(COMPANY_BALANCE_ERROR.PROVIDER_STUB_ZERO);
  });
});
