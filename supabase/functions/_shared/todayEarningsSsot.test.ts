/**
 * Today’s earnings SSOT + driver-earnings-summary lock.
 *
 * Run:
 *   deno test --allow-read --no-check supabase/functions/_shared/todayEarningsSsot.test.ts
 *   deno test --allow-read --no-check supabase/functions/_shared/driverEarningsSummaryLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertFalse } from "https://deno.land/std@0.224.0/assert/assert_false.ts";
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/assert_string_includes.ts";
import {
  isDriverCollectedIsolated,
  isTodayEarningsEligibleRow,
  sumTodayEarningsPence,
  todayEarningsAttributionInstant,
  todayEarningsLondonDayKey,
} from "./todayEarningsSsot.ts";

const LONDON_16_SEP_START = "2026-09-15T23:00:00.000Z";
const LONDON_16_SEP_END = "2026-09-16T23:00:00.000Z";
const LONDON_17_SEP_START = "2026-09-16T23:00:00.000Z";

Deno.test("today: fare-net before tip decision (capture unresolved)", () => {
  const fare = {
    type: "TRIP_EARNING_NET",
    amount_pence: 744,
    posting_created_at: "2026-09-16T17:26:11.438Z",
    economic_earned_at: null,
    economic_date_status: "CAPTURE_NOT_VERIFIED",
  };
  assertEquals(todayEarningsAttributionInstant(fare), fare.posting_created_at);
  assertEquals(sumTodayEarningsPence([fare], LONDON_16_SEP_START, LONDON_16_SEP_END), 744);
});

Deno.test("today: CAPTURE_RELEASED TEN still counts on posting day", () => {
  const feeNet = {
    type: "TRIP_EARNING_NET",
    amount_pence: 435,
    posting_created_at: "2026-09-16T19:25:55.202Z",
    economic_earned_at: null,
    economic_date_status: "CAPTURE_RELEASED",
  };
  assertEquals(sumTodayEarningsPence([feeNet], LONDON_16_SEP_START, LONDON_16_SEP_END), 435);
  assertEquals(todayEarningsLondonDayKey(feeNet), "2026-09-16");
});

Deno.test("today: tip later adds once", () => {
  const fare = {
    type: "TRIP_EARNING_NET",
    amount_pence: 744,
    posting_created_at: "2026-09-16T17:26:11.438Z",
  };
  const tip = {
    type: "DRIVER_TIP_CREDIT",
    amount_pence: 100,
    posting_created_at: "2026-09-16T17:40:00.000Z",
  };
  assertEquals(sumTodayEarningsPence([fare, tip], LONDON_16_SEP_START, LONDON_16_SEP_END), 844);
});

Deno.test("today: no-tip keeps fare-net", () => {
  const fare = {
    type: "TRIP_EARNING_NET",
    amount_pence: 744,
    posting_created_at: "2026-09-16T17:26:11.438Z",
  };
  assertEquals(sumTodayEarningsPence([fare], LONDON_16_SEP_START, LONDON_16_SEP_END), 744);
});

Deno.test("today: multi trip+tip; airport already inside TEN", () => {
  const rows = [
    { type: "TRIP_EARNING_NET", amount_pence: 744, posting_created_at: "2026-09-16T17:26:11.438Z" },
    {
      type: "TRIP_EARNING_NET",
      amount_pence: 435,
      posting_created_at: "2026-09-16T19:25:55.202Z",
      economic_date_status: "CAPTURE_RELEASED",
      economic_earned_at: null,
    },
    { type: "DRIVER_TIP_CREDIT", amount_pence: 50, posting_created_at: "2026-09-16T20:00:00.000Z" },
  ];
  assertEquals(sumTodayEarningsPence(rows, LONDON_16_SEP_START, LONDON_16_SEP_END), 1229);
});

Deno.test("today: settlement correction by sign", () => {
  const rows = [
    { type: "TRIP_EARNING_NET", amount_pence: 500, posting_created_at: "2026-09-16T12:00:00.000Z" },
    { type: "REFUND_DEBIT", amount_pence: -100, posting_created_at: "2026-09-16T13:00:00.000Z" },
  ];
  assertEquals(sumTodayEarningsPence(rows, LONDON_16_SEP_START, LONDON_16_SEP_END), 400);
});

Deno.test("today: withdrawal / hold / early cashout excluded", () => {
  const rows = [
    { type: "TRIP_EARNING_NET", amount_pence: 1179, posting_created_at: "2026-09-16T17:26:11.438Z" },
    { type: "PAYOUT_RESERVATION_HOLD", amount_pence: 3319, posting_created_at: "2026-09-16T21:08:53.978Z" },
    { type: "EARLY_CASHOUT", amount_pence: -3269, posting_created_at: "2026-09-16T21:08:57.625Z" },
  ];
  assertEquals(isTodayEarningsEligibleRow(rows[1]!), false);
  assertEquals(isTodayEarningsEligibleRow(rows[2]!), false);
  assertEquals(sumTodayEarningsPence(rows, LONDON_16_SEP_START, LONDON_16_SEP_END), 1179);
});

Deno.test("today: Pending vs Available clearing ignored", () => {
  const pending = {
    type: "TRIP_EARNING_NET",
    amount_pence: 744,
    posting_created_at: "2026-09-16T17:26:11.438Z",
    clearing_status: "PENDING",
  };
  const available = {
    type: "TRIP_EARNING_NET",
    amount_pence: 435,
    posting_created_at: "2026-09-16T19:25:55.202Z",
    clearing_status: "AVAILABLE",
  };
  assertEquals(
    sumTodayEarningsPence([pending, available], LONDON_16_SEP_START, LONDON_16_SEP_END),
    1179,
  );
});

Deno.test("today: London BST midnight boundary", () => {
  const before = {
    type: "TRIP_EARNING_NET",
    amount_pence: 100,
    posting_created_at: "2026-09-16T22:59:00.000Z",
  };
  const after = {
    type: "TRIP_EARNING_NET",
    amount_pence: 200,
    posting_created_at: "2026-09-16T23:01:00.000Z",
  };
  assertEquals(todayEarningsLondonDayKey(before), "2026-09-16");
  assertEquals(todayEarningsLondonDayKey(after), "2026-09-17");
  assertEquals(sumTodayEarningsPence([before, after], LONDON_16_SEP_START, LONDON_16_SEP_END), 100);
  assertEquals(
    sumTodayEarningsPence([before, after], LONDON_17_SEP_START, "2026-09-17T23:00:00.000Z"),
    200,
  );
});

Deno.test("today: London GMT winter boundary", () => {
  const eve = {
    type: "TRIP_EARNING_NET",
    amount_pence: 10,
    posting_created_at: "2026-01-15T23:59:00.000Z",
  };
  const next = {
    type: "TRIP_EARNING_NET",
    amount_pence: 20,
    posting_created_at: "2026-01-16T00:01:00.000Z",
  };
  assertEquals(todayEarningsLondonDayKey(eve), "2026-01-15");
  assertEquals(todayEarningsLondonDayKey(next), "2026-01-16");
});

Deno.test("today: DRIVER_COLLECTED isolated", () => {
  const cash = {
    type: "TRIP_EARNING_NET",
    amount_pence: 999,
    posting_created_at: "2026-09-16T12:00:00.000Z",
    economic_date_status: "FINANCIAL_MODEL_MISMATCH",
  };
  assertEquals(isDriverCollectedIsolated(cash), true);
  assertEquals(isTodayEarningsEligibleRow(cash), false);
  assertEquals(sumTodayEarningsPence([cash], LONDON_16_SEP_START, LONDON_16_SEP_END), 0);
});

Deno.test("today: audit shape 744+435=1179 with cashout excluded", () => {
  const rows = [
    {
      type: "TRIP_EARNING_NET",
      amount_pence: 744,
      posting_created_at: "2026-09-16T17:26:11.438Z",
      economic_date_status: "RESOLVED",
    },
    {
      type: "TRIP_EARNING_NET",
      amount_pence: 435,
      posting_created_at: "2026-09-16T19:25:55.202Z",
      economic_date_status: "CAPTURE_RELEASED",
      economic_earned_at: null,
    },
    {
      type: "EARLY_CASHOUT",
      amount_pence: -3269,
      posting_created_at: "2026-09-16T21:08:57.625Z",
    },
  ];
  assertEquals(sumTodayEarningsPence(rows, LONDON_16_SEP_START, LONDON_16_SEP_END), 1179);
});

Deno.test("driver-earnings-summary uses todayEarningsSsot posting clock", async () => {
  const src = await Deno.readTextFile(
    new URL("../driver-earnings-summary/index.ts", import.meta.url),
  );
  assertStringIncludes(src, 'from "../_shared/todayEarningsSsot.ts"');
  assertStringIncludes(src, "todayEarningsAttributionInstant");
  assertStringIncludes(src, "isTodayEarningsEligibleRow");
  assertStringIncludes(src, "fetchDriverPayoutEligibility");
  assertEquals(src.includes('from("payment_sessions")'), false);
  assertFalse(src.includes("api.revolut"));
  assertFalse(src.includes(".insert("));
  assertFalse(src.includes("driver_commission_wallet"));
  // Must not use capture fail-closed for period totals anymore.
  assertEquals(src.includes("earningsAttributionInstant"), false);
});
