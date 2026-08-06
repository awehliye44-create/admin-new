/**
 * Required automated matrix M18–M32 (driver earnings invoices).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeNextRunAtUtc,
  periodsAbut,
  resolveEveryNMonthsPeriod,
} from "./driverEarningsPeriod.ts";
import {
  aggregateApprovedDriverLedger,
  canMutateDriverInvoiceArtifact,
  classifyDriverReportLedgerType,
  decideDriverInvoicePageAccess,
  DRIVER_EARNINGS_PAGE_SLUG,
  driverPeriodUniqueKey,
  isEligibleDriverInvoiceEmail,
  resolvePreferredDriverInvoiceEmail,
  scheduleAllowsAutoReport,
  wouldDuplicateDriverPeriod,
} from "./driverInvoiceLedgerPolicy.ts";

Deno.test("M18: configured eight-month interval creates correct period", () => {
  const p = resolveEveryNMonthsPeriod(new Date(Date.UTC(2026, 7, 6)), 8);
  assertEquals(p.periodStartInclusive, "2025-12-06");
  assertEquals(p.periodEndExclusive, "2026-08-06");
});

Deno.test("M19: another configurable interval works without code changes", () => {
  const p = resolveEveryNMonthsPeriod(new Date(Date.UTC(2026, 0, 15)), 3);
  assertEquals(p.periodStartInclusive, "2025-10-15");
  assertEquals(p.periodEndExclusive, "2026-01-15");
});

Deno.test("M20: driver report uses Driver Wallet Ledger SSOT classification", () => {
  assertEquals(classifyDriverReportLedgerType("TRIP_EARNING_NET"), "gross_earning");
  assertEquals(classifyDriverReportLedgerType("TOP_UP"), "excluded");
});

Deno.test("M21: report total includes only approved net-earning entries", () => {
  const totals = aggregateApprovedDriverLedger([
    { id: "e1", type: "TRIP_EARNING_NET", amount_pence: 1000, related_trip_id: "t1", driver_id: "d1" },
    { id: "e2", type: "PLATFORM_COMMISSION", amount_pence: -150, driver_id: "d1" },
    { id: "e3", type: "BONUS", amount_pence: 50, driver_id: "d1" },
  ], "d1");
  assertEquals(totals.netEarningsPence, 1000 - 150 + 50);
  assertEquals(totals.includedIds.length, 3);
});

Deno.test("M22: top-ups, payouts, commission-wallet and unrelated adjustments excluded", () => {
  const totals = aggregateApprovedDriverLedger([
    { id: "keep", type: "TRIP_EARNING_NET", amount_pence: 500, driver_id: "d1" },
    { id: "top", type: "TOP_UP", amount_pence: 2000, driver_id: "d1" },
    { id: "pay", type: "PAYOUT", amount_pence: -500, driver_id: "d1" },
    { id: "cw", type: "COMMISSION_WALLET_CREDIT", amount_pence: 100, driver_id: "d1" },
    { id: "unrel", type: "UNRELATED_ADJUSTMENT", amount_pence: 99, driver_id: "d1" },
  ], "d1");
  assertEquals(totals.includedIds, ["keep"]);
  assertEquals(totals.excludedIds.sort(), ["cw", "pay", "top", "unrel"].sort());
  assertEquals(totals.netEarningsPence, 500);
});

Deno.test("M23: no valid driver email → no fallback and no provider recipient", () => {
  const email = resolvePreferredDriverInvoiceEmail({
    driverProfileEmail: null,
    driverAuthEmail: "not-valid",
    customerProfileEmail: "customer@gmail.com",
    companyEmail: "info@onecab.net",
    adminEmail: "admin@onecab.net",
  });
  assertEquals(email, null);
  assertEquals(isEligibleDriverInvoiceEmail("info@onecab.net"), false);
});

Deno.test("M24: shared identity resolves driver profile email, not customer email", () => {
  const email = resolvePreferredDriverInvoiceEmail({
    driverProfileEmail: "driver.only@gmail.com",
    driverAuthEmail: "shared.auth@gmail.com",
    customerProfileEmail: "customer.shared@gmail.com",
    companyEmail: "info@onecab.net",
    adminEmail: "admin@onecab.net",
  });
  assertEquals(email, "driver.only@gmail.com");
});

Deno.test("M25: re-running same period does not create duplicate", () => {
  const keys = new Set([driverPeriodUniqueKey("d1", "2025-12-06", "2026-08-05")]);
  assertEquals(
    wouldDuplicateDriverPeriod(keys, "d1", "2025-12-06", "2026-08-05"),
    true,
  );
  assertEquals(
    wouldDuplicateDriverPeriod(keys, "d1", "2026-08-06", "2027-04-05"),
    false,
  );
});

Deno.test("M26: two consecutive periods do not overlap", () => {
  const first = resolveEveryNMonthsPeriod(new Date(Date.UTC(2026, 7, 6)), 8);
  const second = resolveEveryNMonthsPeriod(new Date(Date.UTC(2027, 3, 6)), 8);
  assertEquals(periodsAbut(first, second), true);
  assertEquals(second.periodStartInclusive, first.periodEndExclusive);
});

Deno.test("M27: period boundary is UTC-stable across DST transition", () => {
  // UK DST spring-forward weekend 2026-03-29 — period math remains UTC calendar dates.
  const before = resolveEveryNMonthsPeriod(new Date(Date.UTC(2026, 2, 29)), 1);
  const after = resolveEveryNMonthsPeriod(new Date(Date.UTC(2026, 3, 29)), 1);
  assertEquals(before.periodEndExclusive, "2026-03-29");
  assertEquals(after.periodStartInclusive, "2026-03-29");
  assertEquals(periodsAbut(before, after), true);
  const next = computeNextRunAtUtc(new Date(Date.UTC(2026, 2, 5, 9, 0, 0)), 1, 5, 9);
  assertEquals(next.getUTCMonth(), 3);
  assertEquals(next.getUTCDate(), 5);
});

Deno.test("M28: disabled schedule produces no automatic report", () => {
  assertEquals(scheduleAllowsAutoReport({ enabled: false }), false);
  assertEquals(scheduleAllowsAutoReport({ enabled: true, is_auto_generate_enabled: false }), false);
  assertEquals(scheduleAllowsAutoReport({ enabled: true, is_auto_generate_enabled: true }), true);
});

Deno.test("M29: manual generation is permission protected", () => {
  const denied = decideDriverInvoicePageAccess({
    isAdminOrStaff: true,
    roleCanAccessPage: false,
  });
  assertEquals(denied.allowed, false);
  assertEquals(denied.code, "PAGE_FORBIDDEN");
  assertEquals(DRIVER_EARNINGS_PAGE_SLUG, "driver-earnings-invoices");
});

Deno.test("M30: admin/staff role without explicit page permission is rejected", () => {
  const denied = decideDriverInvoicePageAccess({
    isAdminOrStaff: true,
    roleCanAccessPage: false,
  });
  assertEquals(denied.allowed, false);
  const allowed = decideDriverInvoicePageAccess({
    isAdminOrStaff: true,
    roleCanAccessPage: true,
  });
  assertEquals(allowed.allowed, true);
});

Deno.test("M31: one driver’s report never contains another driver’s earnings", () => {
  const totals = aggregateApprovedDriverLedger([
    { id: "mine", type: "TRIP_EARNING_NET", amount_pence: 700, driver_id: "d1" },
    { id: "theirs", type: "TRIP_EARNING_NET", amount_pence: 9999, driver_id: "d2" },
  ], "d1");
  assertEquals(totals.includedIds, ["mine"]);
  assertEquals(totals.excludedIds, ["theirs"]);
  assertEquals(totals.netEarningsPence, 700);
});

Deno.test("M32: already-issued reports are not silently recalculated or overwritten", () => {
  const mutate = canMutateDriverInvoiceArtifact({
    status: "sent",
    invoiceEmailSent: true,
    action: "regenerate",
  });
  assertEquals(mutate.allowed, false);
  assertEquals(mutate.reason, "issued_immutable");
  const send = canMutateDriverInvoiceArtifact({
    status: "finalized",
    invoiceEmailSent: true,
    action: "send_email",
  });
  assertEquals(send.allowed, false);
});
