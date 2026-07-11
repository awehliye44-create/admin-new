import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildDriverWalletPeriodSummary,
  buildDriverWalletSummaryResponse,
  isLedgerRowInPeriod,
} from "./driverWalletPeriodWidgetsSSOT.ts";

Deno.test("period filter timezone-agnostic ISO bounds", () => {
  assertEquals(
    isLedgerRowInPeriod("2026-07-10T12:00:00Z", "2026-07-10T00:00:00.000Z", "2026-07-10T23:59:59.999Z"),
    true,
  );
  assertEquals(
    isLedgerRowInPeriod("2026-07-09T23:59:59Z", "2026-07-10T00:00:00.000Z", "2026-07-10T23:59:59.999Z"),
    false,
  );
});

Deno.test("This Week style summary — platform commission from trip snapshot", () => {
  const summary = buildDriverWalletPeriodSummary({
    periodFrom: "2026-07-07T00:00:00.000Z",
    periodTo: "2026-07-13T23:59:59.999Z",
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 500, related_trip_id: "t1", created_at: "2026-07-08T10:00:00Z" },
      { type: "TRIP_EARNING_NET", amount_pence: 486, related_trip_id: "t2", created_at: "2026-07-09T10:00:00Z" },
      { type: "PLATFORM_COMMISSION", amount_pence: 999, related_trip_id: "t1", created_at: "2026-07-08T10:00:00Z" },
      { type: "WEEKLY_PAYOUT", amount_pence: 0, created_at: "2026-07-08T12:00:00Z" },
    ],
    tripCommissionSnapshots: [
      { trip_id: "t1", completed_at: "2026-07-08T09:00:00Z", commission_pence: 88 },
      { trip_id: "t2", completed_at: "2026-07-09T09:00:00Z", commission_pence: 86 },
    ],
  });
  assertEquals(summary.driver_net_earnings_pence, 986);
  assertEquals(summary.trip_credit_pence, 986);
  assertEquals(summary.paid_trip_count, 2);
  assertEquals(summary.platform_commission_pence, 174);
  assertEquals(summary.net_wallet_movement_pence, 986); // commission excluded
});

Deno.test("empty period zeros; account balances unchanged in response builder", () => {
  const res = buildDriverWalletSummaryResponse({
    periodKey: "today",
    periodFrom: "2026-07-11T00:00:00.000Z",
    periodTo: "2026-07-11T23:59:59.999Z",
    account: {
      live_balance_pence: 1058,
      available_balance_pence: 1058,
      pending_balance_pence: 0,
      outstanding_debt_pence: 0,
      annual_driver_earnings_pence: 0,
    },
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 500, related_trip_id: "old", created_at: "2026-07-01T10:00:00Z" },
    ],
  });
  assertEquals(res.summary.trip_credit_pence, 0);
  assertEquals(res.summary.paid_trip_count, 0);
  assertEquals(res.summary.net_wallet_movement_pence, 0);
  assertEquals(res.account.live_balance_pence, 1058);
  assertEquals(res.account.available_balance_pence, 1058);
});

Deno.test("provider fee must not reduce driver net", () => {
  const summary = buildDriverWalletPeriodSummary({
    periodFrom: "2026-07-10T00:00:00.000Z",
    periodTo: "2026-07-10T23:59:59.999Z",
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 408, related_trip_id: "t1", created_at: "2026-07-10T12:00:00Z" },
      { type: "PAYMENT_PROVIDER_FEE", amount_pence: -27, created_at: "2026-07-10T12:00:00Z" },
    ],
    tripCommissionSnapshots: [
      { trip_id: "t1", completed_at: "2026-07-10T11:00:00Z", commission_pence: 102 },
    ],
  });
  assertEquals(summary.driver_net_earnings_pence, 408);
  assertEquals(summary.net_wallet_movement_pence, 408);
  assertEquals(summary.platform_commission_pence, 102);
});

Deno.test("live update after completed trip credit", () => {
  const periodFrom = "2026-07-07T00:00:00.000Z";
  const periodTo = "2026-07-13T23:59:59.999Z";
  const before = buildDriverWalletSummaryResponse({
    periodKey: "week",
    periodFrom,
    periodTo,
    account: {
      live_balance_pence: 572,
      available_balance_pence: 572,
      pending_balance_pence: 0,
      outstanding_debt_pence: 0,
      annual_driver_earnings_pence: 0,
    },
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 572, related_trip_id: "t0", created_at: "2026-07-08T10:00:00Z" },
    ],
  });
  const after = buildDriverWalletSummaryResponse({
    periodKey: "week",
    periodFrom,
    periodTo,
    account: {
      live_balance_pence: 1058,
      available_balance_pence: 1058,
      pending_balance_pence: 0,
      outstanding_debt_pence: 0,
      annual_driver_earnings_pence: 0,
    },
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 572, related_trip_id: "t0", created_at: "2026-07-08T10:00:00Z" },
      { type: "TRIP_EARNING_NET", amount_pence: 486, related_trip_id: "t1", created_at: "2026-07-10T12:00:00Z" },
    ],
    tripCommissionSnapshots: [
      { trip_id: "t1", completed_at: "2026-07-10T11:00:00Z", commission_pence: 86 },
    ],
  });
  assertEquals(before.summary.trip_credit_pence, 572);
  assertEquals(after.summary.trip_credit_pence, 1058);
  assertEquals(after.account.live_balance_pence, 1058);
  assertEquals(after.summary.net_wallet_movement_pence - before.summary.net_wallet_movement_pence, 486);
});
