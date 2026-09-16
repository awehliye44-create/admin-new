/**
 * Today’s earnings SSOT — strengthened timestamp precedence (Admin / Edge).
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
const LONDON_17_SEP_END = "2026-09-17T23:00:00.000Z";

Deno.test("today: normal TEN keeps economic day when posting differs", () => {
  const row = {
    type: "TRIP_EARNING_NET",
    amount_pence: 425,
    posting_created_at: "2026-08-18T15:00:00.000Z",
    economic_earned_at: "2026-08-17T18:50:46.198Z",
    economic_date_status: "RESOLVED",
  };
  assertEquals(todayEarningsAttributionInstant(row), row.economic_earned_at);
  assertEquals(todayEarningsLondonDayKey(row), "2026-08-17");
  assertEquals(
    sumTodayEarningsPence([row], "2026-08-16T23:00:00.000Z", "2026-08-17T23:00:00.000Z"),
    425,
  );
  assertEquals(
    sumTodayEarningsPence([row], "2026-08-17T23:00:00.000Z", "2026-08-18T23:00:00.000Z"),
    0,
  );
});

Deno.test("today: CAPTURE_RELEASED null economic falls back to posting", () => {
  const row = {
    type: "TRIP_EARNING_NET",
    amount_pence: 435,
    posting_created_at: "2026-09-16T19:25:55.202Z",
    economic_earned_at: null,
    economic_date_status: "CAPTURE_RELEASED",
  };
  assertEquals(todayEarningsAttributionInstant(row), row.posting_created_at);
  assertEquals(sumTodayEarningsPence([row], LONDON_16_SEP_START, LONDON_16_SEP_END), 435);
});

Deno.test("today: late-cancel fee 435p fixture", () => {
  const feeNet = {
    type: "TRIP_EARNING_NET",
    amount_pence: 435,
    posting_created_at: "2026-09-16T19:25:55.202Z",
    economic_earned_at: null,
    economic_date_status: "CAPTURE_RELEASED",
  };
  assertEquals(isTodayEarningsEligibleRow(feeNet), true);
  assertEquals(sumTodayEarningsPence([feeNet], LONDON_16_SEP_START, LONDON_16_SEP_END), 435);
});

Deno.test("today: delayed tip posted following day", () => {
  const fare = {
    type: "TRIP_EARNING_NET",
    amount_pence: 744,
    posting_created_at: "2026-09-16T17:26:11.438Z",
    economic_earned_at: "2026-09-16T17:27:11.281Z",
    economic_date_status: "RESOLVED",
  };
  const tipNextDay = {
    type: "DRIVER_TIP_CREDIT",
    amount_pence: 100,
    posting_created_at: "2026-09-16T23:30:00.000Z",
    economic_earned_at: null,
  };
  assertEquals(todayEarningsLondonDayKey(tipNextDay), "2026-09-17");
  assertEquals(sumTodayEarningsPence([fare, tipNextDay], LONDON_16_SEP_START, LONDON_16_SEP_END), 744);
  assertEquals(sumTodayEarningsPence([fare, tipNextDay], LONDON_17_SEP_START, LONDON_17_SEP_END), 100);
});

Deno.test("today: tip-effective economic timestamp preferred when present", () => {
  const tip = {
    type: "DRIVER_TIP_CREDIT",
    amount_pence: 50,
    posting_created_at: "2026-09-17T01:00:00.000Z",
    economic_earned_at: "2026-09-16T20:00:00.000Z",
  };
  assertEquals(todayEarningsAttributionInstant(tip), tip.economic_earned_at);
  assertEquals(todayEarningsLondonDayKey(tip), "2026-09-16");
});

Deno.test("today: backfilled historical credit keeps economic day", () => {
  const backfill = {
    type: "TRIP_EARNING_NET",
    amount_pence: 300,
    posting_created_at: "2026-09-20T12:00:00.000Z",
    economic_earned_at: "2026-09-10T14:00:00.000Z",
    economic_date_status: "RESOLVED",
  };
  assertEquals(todayEarningsLondonDayKey(backfill), "2026-09-10");
  assertEquals(
    sumTodayEarningsPence([backfill], "2026-09-19T23:00:00.000Z", "2026-09-20T23:00:00.000Z"),
    0,
  );
  assertEquals(
    sumTodayEarningsPence([backfill], "2026-09-09T23:00:00.000Z", "2026-09-10T23:00:00.000Z"),
    300,
  );
});

Deno.test("today: backfilled null economic uses posting fallback", () => {
  const orphan = {
    type: "TRIP_EARNING_NET",
    amount_pence: 200,
    posting_created_at: "2026-09-20T12:00:00.000Z",
    economic_earned_at: null,
    economic_date_status: "CAPTURE_NOT_VERIFIED",
  };
  assertEquals(todayEarningsAttributionInstant(orphan), orphan.posting_created_at);
  assertEquals(todayEarningsLondonDayKey(orphan), "2026-09-20");
});

Deno.test("today: London BST midnight boundary", () => {
  const before = {
    type: "TRIP_EARNING_NET",
    amount_pence: 100,
    posting_created_at: "2026-09-16T22:59:00.000Z",
    economic_earned_at: null,
  };
  const after = {
    type: "TRIP_EARNING_NET",
    amount_pence: 200,
    posting_created_at: "2026-09-16T23:01:00.000Z",
    economic_earned_at: null,
  };
  assertEquals(todayEarningsLondonDayKey(before), "2026-09-16");
  assertEquals(todayEarningsLondonDayKey(after), "2026-09-17");
});

Deno.test("today: London GMT winter midnight boundary", () => {
  const eve = {
    type: "TRIP_EARNING_NET",
    amount_pence: 10,
    posting_created_at: "2026-01-15T23:59:00.000Z",
    economic_earned_at: null,
  };
  const next = {
    type: "TRIP_EARNING_NET",
    amount_pence: 20,
    posting_created_at: "2026-01-16T00:01:00.000Z",
    economic_earned_at: null,
  };
  assertEquals(todayEarningsLondonDayKey(eve), "2026-01-15");
  assertEquals(todayEarningsLondonDayKey(next), "2026-01-16");
});

Deno.test("today: withdrawal and early cashout excluded", () => {
  const rows = [
    {
      type: "TRIP_EARNING_NET",
      amount_pence: 1179,
      posting_created_at: "2026-09-16T17:26:11.438Z",
      economic_earned_at: "2026-09-16T17:27:11.281Z",
    },
    { type: "PAYOUT_RESERVATION_HOLD", amount_pence: 3319, posting_created_at: "2026-09-16T21:08:53.978Z" },
    { type: "EARLY_CASHOUT", amount_pence: -3269, posting_created_at: "2026-09-16T21:08:57.625Z" },
  ];
  assertEquals(isTodayEarningsEligibleRow(rows[1]!), false);
  assertEquals(isTodayEarningsEligibleRow(rows[2]!), false);
  assertEquals(sumTodayEarningsPence(rows, LONDON_16_SEP_START, LONDON_16_SEP_END), 1179);
});

Deno.test("today: signed REFUND_DEBIT correction", () => {
  const rows = [
    {
      type: "TRIP_EARNING_NET",
      amount_pence: 500,
      posting_created_at: "2026-09-16T12:00:00.000Z",
      economic_earned_at: "2026-09-16T12:00:00.000Z",
    },
    { type: "REFUND_DEBIT", amount_pence: -100, posting_created_at: "2026-09-16T13:00:00.000Z" },
  ];
  assertEquals(sumTodayEarningsPence(rows, LONDON_16_SEP_START, LONDON_16_SEP_END), 400);
});

Deno.test("today: DRIVER_COLLECTED isolated", () => {
  const cash = {
    type: "TRIP_EARNING_NET",
    amount_pence: 999,
    posting_created_at: "2026-09-16T12:00:00.000Z",
    economic_date_status: "FINANCIAL_MODEL_MISMATCH",
  };
  assertEquals(isDriverCollectedIsolated(cash), true);
  assertEquals(sumTodayEarningsPence([cash], LONDON_16_SEP_START, LONDON_16_SEP_END), 0);
});

Deno.test("today: MK0006 744 + 435 = 1179", () => {
  const resolved = {
    type: "TRIP_EARNING_NET",
    amount_pence: 744,
    posting_created_at: "2026-09-16T17:26:11.438Z",
    economic_earned_at: "2026-09-16T17:27:11.281Z",
    economic_date_status: "RESOLVED",
  };
  const released = {
    type: "TRIP_EARNING_NET",
    amount_pence: 435,
    posting_created_at: "2026-09-16T19:25:55.202Z",
    economic_earned_at: null,
    economic_date_status: "CAPTURE_RELEASED",
  };
  const cashout = {
    type: "EARLY_CASHOUT",
    amount_pence: -3269,
    posting_created_at: "2026-09-16T21:08:57.625Z",
  };
  const before = sumTodayEarningsPence([resolved], LONDON_16_SEP_START, LONDON_16_SEP_END);
  const after = sumTodayEarningsPence(
    [resolved, released, cashout],
    LONDON_16_SEP_START,
    LONDON_16_SEP_END,
  );
  assertEquals(before, 744);
  assertEquals(after - before, 435);
  assertEquals(after, 1179);
});

Deno.test("driver-earnings-summary uses todayEarningsSsot posting+economic clock", async () => {
  const src = await Deno.readTextFile(
    new URL("../driver-earnings-summary/index.ts", import.meta.url),
  );
  assertStringIncludes(src, 'from "../_shared/todayEarningsSsot.ts"');
  assertStringIncludes(src, "todayEarningsAttributionInstant");
  assertStringIncludes(src, "isTodayEarningsEligibleRow");
  assertEquals(src.includes('from("payment_sessions")'), false);
  assertFalse(src.includes("api.revolut"));
  assertEquals(src.includes("earningsAttributionInstant"), false);
});
