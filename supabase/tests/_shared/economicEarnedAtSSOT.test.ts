/**
 * Economic earning-date SSOT — consume-only + SQL resolver spec + 4C locks.
 *
 * Run:
 *   deno test --allow-read supabase/functions/_shared/economicEarnedAtSSOT.test.ts
 */
import { assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ECONOMIC_DATE_STATUS,
  earningsAttributionInstant,
  isInstantInClosedRange,
  londonCivilDateKey,
  sumAttributedTripEarningNetPence,
} from "./economicEarnedAtSSOT.ts";
import {
  PAYMENT_SESSION_PURPOSE_PAYMENT_RECOVERY,
  specResolveEconomicDate,
  type SpecPaymentSession,
} from "./economicEarnedAtResolverSpec.ts";
import {
  DEFAULT_PAYOUT_CLEARING_DELAY_HOURS,
  isPayoutClearedForPlatformCollected,
} from "./driverPayoutEligibilitySSOT.ts";
import { buildDriverWalletPeriodKpis } from "./driverWalletPeriodKpisSSOT.ts";
import { getLondonDayBounds } from "./financeLondonDay.ts";

const LONDON_17_AUG_START = "2026-08-16T23:00:00.000Z";
const LONDON_17_AUG_END = "2026-08-17T23:00:00.000Z";
const LONDON_18_AUG_START = "2026-08-17T23:00:00.000Z";
const LONDON_18_AUG_END = "2026-08-18T23:00:00.000Z";

const MK005_TRIP = "021af8ee-f2a0-446d-9bbd-ade076f726b6";
const MK007_TRIP = "8b39acc6-91d0-43cb-b20a-49d9ef0feebd";
const MK008_TRIP = "3b48b86c-9ebf-407e-bb8b-a51ad2e75edc";
const MK009_TRIP = "be49d383-6a8b-4cb0-9da3-2bec9d496d93";
const MK002_TRIP = "mk-260818-002";
const MK003_TRIP = "mk-260818-003";

function verifiedBooking(
  capturedAt: string,
  amountPence: number,
  extras: Partial<SpecPaymentSession> = {},
): SpecPaymentSession {
  return {
    purpose: "RIDE_BOOKING",
    captured_at: capturedAt,
    captured_amount_pence: amountPence,
    refunded_amount_pence: 0,
    released_amount_pence: 0,
    refunded_at: null,
    released_at: null,
    status: "CAPTURED",
    provider_state: "CAPTURED",
    provider_state_verified_at: capturedAt,
    ...extras,
  };
}

function attachFromSpec(
  rows: Array<{
    type: string;
    related_trip_id: string;
    created_at: string;
    amount_pence: number;
    financial_model?: string;
    sessions?: SpecPaymentSession[];
  }>,
) {
  return rows.map((row) => {
    const resolved = specResolveEconomicDate({
      type: row.type,
      related_trip_id: row.related_trip_id,
      created_at: row.created_at,
      financial_model: row.financial_model ?? "PLATFORM_COLLECTED",
      sessions: row.sessions,
    });
    return {
      ...row,
      posting_created_at: resolved.posting_created_at,
      economic_earned_at: resolved.economic_earned_at,
      economic_date_status: resolved.economic_date_status,
      captured_at: resolved.captured_at,
    };
  });
}

function mkSimulatedRecoveryRows() {
  const rows = [
    {
      type: "TRIP_EARNING_NET",
      related_trip_id: MK005_TRIP,
      created_at: "2026-08-17T11:44:02.234Z",
      amount_pence: 637,
      sessions: [verifiedBooking("2026-08-17T08:42:50.690Z", 699)],
    },
    {
      type: "TRIP_EARNING_NET",
      related_trip_id: MK007_TRIP,
      created_at: "2026-08-18T15:00:00.000Z",
      amount_pence: 425,
      sessions: [verifiedBooking("2026-08-17T18:50:46.198Z", 480)],
    },
    {
      type: "TRIP_EARNING_NET",
      related_trip_id: MK009_TRIP,
      created_at: "2026-08-18T15:00:01.000Z",
      amount_pence: 706,
      sessions: [verifiedBooking("2026-08-17T19:27:16.212Z", 798)],
    },
    {
      type: "TRIP_EARNING_NET",
      related_trip_id: MK002_TRIP,
      created_at: "2026-08-18T15:24:15.863Z",
      amount_pence: 425,
      sessions: [verifiedBooking("2026-08-18T10:52:08.848Z", 500)],
    },
    {
      type: "TRIP_EARNING_NET",
      related_trip_id: MK003_TRIP,
      created_at: "2026-08-18T15:24:16.628Z",
      amount_pence: 425,
      sessions: [verifiedBooking("2026-08-18T13:35:47.011Z", 500)],
    },
  ];
  return attachFromSpec(rows);
}

Deno.test("M: MK-005 created_at 17 Aug + captured_at 17 Aug → 17 Aug 637p", () => {
  const row = mkSimulatedRecoveryRows().find((r) => r.related_trip_id === MK005_TRIP)!;
  assertEquals(row.posting_created_at, "2026-08-17T11:44:02.234Z");
  assertEquals(row.economic_earned_at, "2026-08-17T08:42:50.690Z");
  assertEquals(londonCivilDateKey(row.economic_earned_at), "2026-08-17");
  assertEquals(row.economic_date_status, ECONOMIC_DATE_STATUS.RESOLVED);
  assertEquals(row.amount_pence, 637);
});

Deno.test("N: simulated late MK-007 recovery attributes 425p to 17 Aug", () => {
  const row = mkSimulatedRecoveryRows().find((r) => r.related_trip_id === MK007_TRIP)!;
  assertEquals(londonCivilDateKey(row.posting_created_at), "2026-08-18");
  assertEquals(londonCivilDateKey(row.economic_earned_at), "2026-08-17");
  assertEquals(row.amount_pence, 425);
});

Deno.test("O: simulated late MK-009 recovery attributes 706p to 17 Aug", () => {
  const row = mkSimulatedRecoveryRows().find((r) => r.related_trip_id === MK009_TRIP)!;
  assertEquals(londonCivilDateKey(row.posting_created_at), "2026-08-18");
  assertEquals(londonCivilDateKey(row.economic_earned_at), "2026-08-17");
  assertEquals(row.amount_pence, 706);
});

Deno.test("P: MK-002/MK-003 remain on 18 Aug", () => {
  for (const tripId of [MK002_TRIP, MK003_TRIP]) {
    const row = mkSimulatedRecoveryRows().find((r) => r.related_trip_id === tripId)!;
    assertEquals(londonCivilDateKey(row.posting_created_at), "2026-08-18");
    assertEquals(londonCivilDateKey(row.economic_earned_at), "2026-08-18");
  }
});

Deno.test("Q/R: 17 Aug excluding MK-008 = 1,768p; MK-008 remains PENDING_EVIDENCE", () => {
  const attached = mkSimulatedRecoveryRows();
  assertEquals(attached.some((r) => r.related_trip_id === MK008_TRIP), false);
  const aug17 = sumAttributedTripEarningNetPence(attached, LONDON_17_AUG_START, LONDON_17_AUG_END);
  const aug18 = sumAttributedTripEarningNetPence(attached, LONDON_18_AUG_START, LONDON_18_AUG_END);
  assertEquals(aug17, 1768);
  assertEquals((1768 / 100).toFixed(2), "17.68");
  assertEquals(aug18, 850);
});

Deno.test("C: DRIVER_COLLECTED trip cannot resolve TEN economic date", () => {
  const r = specResolveEconomicDate({
    type: "TRIP_EARNING_NET",
    related_trip_id: MK007_TRIP,
    created_at: "2026-08-18T15:00:00.000Z",
    financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
    sessions: [verifiedBooking("2026-08-17T18:50:46.198Z", 480)],
  });
  assertEquals(r.economic_earned_at, null);
  assertEquals(r.economic_date_status, ECONOMIC_DATE_STATUS.FINANCIAL_MODEL_MISMATCH);
});

Deno.test("D: PAYMENT_RECOVERY does not become the trip earning origin", () => {
  const recoveryOnly = specResolveEconomicDate({
    type: "TRIP_EARNING_NET",
    related_trip_id: MK007_TRIP,
    created_at: "2026-08-18T15:00:00.000Z",
    financial_model: "PLATFORM_COLLECTED",
    sessions: [{
      purpose: PAYMENT_SESSION_PURPOSE_PAYMENT_RECOVERY,
      captured_at: "2026-08-18T14:00:00.000Z",
      captured_amount_pence: 480,
      status: "CAPTURED",
      provider_state: "CAPTURED",
      provider_state_verified_at: "2026-08-18T14:00:00.000Z",
    }],
  });
  assertEquals(recoveryOnly.economic_earned_at, null);
  assertEquals(recoveryOnly.economic_date_status, ECONOMIC_DATE_STATUS.PAYMENT_SESSION_MISSING);

  const bookingWins = specResolveEconomicDate({
    type: "TRIP_EARNING_NET",
    related_trip_id: MK007_TRIP,
    created_at: "2026-08-18T15:00:00.000Z",
    financial_model: "PLATFORM_COLLECTED",
    sessions: [
      {
        purpose: PAYMENT_SESSION_PURPOSE_PAYMENT_RECOVERY,
        captured_at: "2026-08-18T14:00:00.000Z",
        captured_amount_pence: 480,
        status: "CAPTURED",
        provider_state: "CAPTURED",
        provider_state_verified_at: "2026-08-18T14:00:00.000Z",
      },
      verifiedBooking("2026-08-17T18:50:46.198Z", 480),
    ],
  });
  assertEquals(bookingWins.economic_earned_at, "2026-08-17T18:50:46.198Z");
  assertEquals(bookingWins.economic_date_status, ECONOMIC_DATE_STATUS.RESOLVED);
});

Deno.test("E: two RIDE_BOOKING rows always fail closed, even if capture fields match", () => {
  const identical = specResolveEconomicDate({
    type: "TRIP_EARNING_NET",
    related_trip_id: MK007_TRIP,
    created_at: "2026-08-18T15:00:00.000Z",
    financial_model: "PLATFORM_COLLECTED",
    sessions: [
      verifiedBooking("2026-08-17T18:50:46.198Z", 480),
      verifiedBooking("2026-08-17T18:50:46.198Z", 480),
    ],
  });
  assertEquals(identical.economic_earned_at, null);
  assertEquals(identical.economic_date_status, ECONOMIC_DATE_STATUS.CAPTURE_AMBIGUOUS);

  const distinct = specResolveEconomicDate({
    type: "TRIP_EARNING_NET",
    related_trip_id: MK007_TRIP,
    created_at: "2026-08-18T15:00:00.000Z",
    financial_model: "PLATFORM_COLLECTED",
    sessions: [
      verifiedBooking("2026-08-17T18:50:46.198Z", 480),
      verifiedBooking("2026-08-17T19:00:00.000Z", 500),
    ],
  });
  assertEquals(distinct.economic_earned_at, null);
  assertEquals(distinct.economic_date_status, ECONOMIC_DATE_STATUS.CAPTURE_AMBIGUOUS);
});

Deno.test("F: refunded/released capture fails closed", () => {
  const refunded = specResolveEconomicDate({
    type: "TRIP_EARNING_NET",
    related_trip_id: MK007_TRIP,
    created_at: "2026-08-18T15:00:00.000Z",
    financial_model: "PLATFORM_COLLECTED",
    sessions: [verifiedBooking("2026-08-17T18:50:46.198Z", 480, {
      refunded_at: "2026-08-17T20:00:00.000Z",
      refunded_amount_pence: 480,
      status: "REFUNDED",
    })],
  });
  assertEquals(refunded.economic_earned_at, null);
  assertEquals(refunded.economic_date_status, ECONOMIC_DATE_STATUS.CAPTURE_REFUNDED);

  const released = specResolveEconomicDate({
    type: "TRIP_EARNING_NET",
    related_trip_id: MK007_TRIP,
    created_at: "2026-08-18T15:00:00.000Z",
    financial_model: "PLATFORM_COLLECTED",
    sessions: [verifiedBooking("2026-08-17T18:50:46.198Z", 480, {
      released_at: "2026-08-17T20:00:00.000Z",
      released_amount_pence: 480,
      status: "RELEASED",
    })],
  });
  assertEquals(released.economic_earned_at, null);
  assertEquals(released.economic_date_status, ECONOMIC_DATE_STATUS.CAPTURE_RELEASED);
});

Deno.test("G: missing captured_at fails closed", () => {
  const r = specResolveEconomicDate({
    type: "TRIP_EARNING_NET",
    related_trip_id: MK007_TRIP,
    created_at: "2026-08-18T15:00:00.000Z",
    financial_model: "PLATFORM_COLLECTED",
    sessions: [verifiedBooking("2026-08-17T18:50:46.198Z", 480, { captured_at: null })],
  });
  assertEquals(r.economic_earned_at, null);
  assertEquals(r.economic_date_status, ECONOMIC_DATE_STATUS.CAPTURE_TIMESTAMP_MISSING);
});

Deno.test("H: unresolved date leaves live wallet / lifetime unchanged", () => {
  const now = new Date("2026-08-18T16:00:00Z");
  const kpis = buildDriverWalletPeriodKpis(
    [
      {
        type: "TRIP_EARNING_NET",
        amount_pence: 637,
        created_at: "2026-08-17T11:44:02.234Z",
        economic_earned_at: "2026-08-17T08:42:50.690Z",
        related_trip_id: MK005_TRIP,
      },
      {
        type: "TRIP_EARNING_NET",
        amount_pence: 425,
        created_at: "2026-08-18T15:00:00.000Z",
        economic_earned_at: null,
        related_trip_id: MK007_TRIP,
      },
    ],
    { now },
  );
  assertEquals(kpis.lifetime_earnings_pence, 1062);
  assertEquals(kpis.today_earnings_pence, 0);
  assertEquals(earningsAttributionInstant({
    type: "TRIP_EARNING_NET",
    created_at: "2026-08-18T15:00:00.000Z",
    economic_earned_at: null,
  }), null);
});

Deno.test("I: wallet activity continues showing ledger created_at", () => {
  const row = mkSimulatedRecoveryRows().find((r) => r.related_trip_id === MK007_TRIP)!;
  assertEquals(row.created_at, "2026-08-18T15:00:00.000Z");
  assertEquals(row.posting_created_at, row.created_at);
  assertEquals(row.economic_earned_at !== row.posting_created_at, true);
});

Deno.test("J: Pending/Available remains captured_at + 27h", () => {
  const capture = "2026-08-17T18:50:46.198Z";
  const nowBeforeClear = Date.parse("2026-08-18T16:00:00.000Z");
  const nowAfterClear = Date.parse("2026-08-18T22:00:00.000Z");
  assertFalse(isPayoutClearedForPlatformCollected({
    payment_collection_model: "PLATFORM_COLLECTED",
    captured_at: capture,
  }, { now_ms: nowBeforeClear, clearing_delay_hours: DEFAULT_PAYOUT_CLEARING_DELAY_HOURS }));
  assertEquals(isPayoutClearedForPlatformCollected({
    payment_collection_model: "PLATFORM_COLLECTED",
    captured_at: capture,
  }, { now_ms: nowAfterClear, clearing_delay_hours: DEFAULT_PAYOUT_CLEARING_DELAY_HOURS }), true);
});

Deno.test("K: London DST civil-day boundaries", () => {
  const spring = getLondonDayBounds(new Date("2026-03-29T12:00:00.000Z"));
  const autumn = getLondonDayBounds(new Date("2026-10-25T12:00:00.000Z"));
  assertEquals(spring.start.toISOString(), "2026-03-28T23:00:00.000Z");
  assertEquals(spring.end.toISOString(), "2026-03-29T22:59:59.999Z");
  assertEquals(autumn.start.toISOString(), "2026-10-25T00:00:00.000Z");
  assertEquals(autumn.end.toISOString(), "2026-10-25T23:59:59.999Z");
  assertEquals(londonCivilDateKey("2026-03-29T00:30:00.000Z"), "2026-03-29");
  assertEquals(londonCivilDateKey("2026-10-25T00:30:00.000Z"), "2026-10-25");
});

Deno.test("admin period widgets: 17 Aug trip credits = £17.68; net movement stays posting-dated", () => {
  const attached = mkSimulatedRecoveryRows();
  const periodTo17 = "2026-08-17T22:59:59.999Z";
  const periodTo18 = "2026-08-18T22:59:59.999Z";
  let trip17 = 0;
  let move17 = 0;
  let trip18 = 0;
  let move18 = 0;
  for (const row of attached) {
    const amount = Number(row.amount_pence ?? 0);
    if (isInstantInClosedRange(row.created_at, LONDON_17_AUG_START, periodTo17)) move17 += amount;
    if (isInstantInClosedRange(row.created_at, LONDON_18_AUG_START, periodTo18)) move18 += amount;
    const earningIso = earningsAttributionInstant(row);
    if (isInstantInClosedRange(earningIso, LONDON_17_AUG_START, periodTo17)) trip17 += amount;
    if (isInstantInClosedRange(earningIso, LONDON_18_AUG_START, periodTo18)) trip18 += amount;
  }
  assertEquals(trip17, 1768);
  assertEquals(move17, 637);
  assertEquals(trip18, 850);
  assertEquals(move18, 425 + 706 + 425 + 425);
});

Deno.test("A/B/L: SQL ownership, anon reject, no money writes", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260929120000_driver_wallet_economic_earned_at.sql", import.meta.url),
  );
  const stripped = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assertFalse(/\bINSERT\s+INTO\b/i.test(stripped));
  assertFalse(/\bUPDATE\s+public\./i.test(stripped));
  assertFalse(/\bDELETE\s+FROM\b/i.test(stripped));
  assertFalse(/EXECUTE\s+format/i.test(stripped));
  assertFalse(/EXECUTE\s+'/i.test(stripped));
  assertEquals(sql.includes("SET search_path TO 'pg_catalog'"), true);
  assertFalse(sql.includes("SET search_path TO 'public'"));
  assertEquals(sql.includes("ELSIF v_booking_count > 1 THEN"), true);
  assertEquals(sql.includes("v_status := 'CAPTURE_AMBIGUOUS'"), true);
  assertFalse(/SELECT DISTINCT captured_at, captured_amount_pence/i.test(sql));
  assertEquals(sql.includes("current_driver_id()"), true);
  assertEquals(sql.includes("ERRCODE = '42501'"), true);
  assertEquals(sql.includes("get_driver_own_wallet_earning_rows(\n  p_start timestamptz,\n  p_end timestamptz\n)"), true);
  assertFalse(/get_driver_own_wallet_earning_rows\(\s*p_driver_id/i.test(sql));
  assertEquals(sql.includes("REVOKE ALL ON FUNCTION public.get_driver_own_wallet_earning_rows(timestamptz, timestamptz) FROM PUBLIC, anon"), true);
  assertEquals(sql.includes("GRANT EXECUTE ON FUNCTION public.get_driver_own_wallet_earning_rows(timestamptz, timestamptz) TO authenticated;"), true);
  assertEquals(sql.includes("v_self IS DISTINCT FROM p_driver_id"), true);
  assertEquals(sql.includes("IF v_role IS DISTINCT FROM 'authenticated'"), true);
  assertEquals(sql.includes("AND upper(coalesce(purpose, '')) = 'RIDE_BOOKING'"), true);
  assertEquals(sql.includes("PLATFORM_COLLECTED"), true);
  assertEquals(sql.includes("DRIVER_COLLECTED_COMMISSION_WALLET"), false);
  assertEquals(sql.includes("provider_state_verified_at IS NOT NULL"), true);
  assertEquals(stripped.includes("created_at ="), false);
});

Deno.test("4D.4: return-type migration casts int4 ledger money; 12/13 stay frozen", async () => {
  const mig12 = await Deno.readTextFile(
    new URL("../../migrations/20260929120000_driver_wallet_economic_earned_at.sql", import.meta.url),
  );
  const mig13 = await Deno.readTextFile(
    new URL("../../migrations/20260929130000_driver_wallet_economic_earned_at_enum_safe.sql", import.meta.url),
  );
  const mig14 = await Deno.readTextFile(
    new URL("../../migrations/20260929140000_driver_wallet_economic_earned_at_return_types.sql", import.meta.url),
  );
  const snapshot = JSON.parse(
    await Deno.readTextFile(new URL("./driverWalletEconomicSchemaSnapshot.json", import.meta.url)),
  ) as { columns: { table: string; column: string; data_type: string; udt_name: string }[] };
  const throwaway = await Deno.readTextFile(
    new URL("../../../.rollback-step4d4-2026-08-18/throwaway_schema.sql", import.meta.url),
  );
  const ledgerAmt = snapshot.columns.find((c) =>
    c.table === "driver_wallet_ledger" && c.column === "amount_pence"
  );
  assertEquals(ledgerAmt?.data_type, "integer");
  assertEquals(ledgerAmt?.udt_name, "int4");
  const ledgerBlock = throwaway.slice(
    throwaway.indexOf("CREATE TABLE public.driver_wallet_ledger"),
    throwaway.indexOf("CREATE TABLE public.driver_early_cashouts"),
  );
  assertEquals(ledgerBlock.includes("amount_pence integer NOT NULL"), true);
  assertEquals(ledgerBlock.includes("amount_pence bigint"), false);
  const psBlock = throwaway.slice(
    throwaway.indexOf("CREATE TABLE public.payment_sessions"),
    throwaway.indexOf("CREATE TABLE public.driver_wallet_ledger"),
  );
  assertEquals(psBlock.includes("captured_amount_pence integer"), true);
  const payoutBlock = throwaway.slice(
    throwaway.indexOf("CREATE TABLE public.payout_items"),
    throwaway.indexOf("CREATE TABLE public.driver_payout_reservations"),
  );
  assertEquals(payoutBlock.includes("amount_pence integer NOT NULL"), true);

  assertEquals(mig12.includes("AND upper(coalesce(purpose, '')) = 'RIDE_BOOKING'"), true);
  assertEquals(mig13.includes("dwl.amount_pence::bigint AS amount_pence"), false);
  assertEquals(mig13.includes("    dwl.amount_pence,\n"), true);
  assertEquals(mig14.includes("dwl.amount_pence::bigint AS amount_pence"), true);
  assertEquals(mig14.split("dwl.amount_pence::bigint AS amount_pence").length - 1, 2);
  assertEquals(mig14.includes("ps.purpose = 'RIDE_BOOKING'::public.payment_session_purpose"), true);
  assertEquals(mig14.includes("upper(ps.status::text)"), true);
  assertEquals(mig14.includes("SET search_path TO 'pg_catalog'"), true);
  assertFalse(mig14.includes("SET search_path TO 'public'"));
  const stripped = mig14.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assertFalse(/\bINSERT\s+INTO\b/i.test(stripped));
  assertFalse(/\bUPDATE\s+public\./i.test(stripped));
  assertFalse(/\bDELETE\s+FROM\b/i.test(stripped));
  assertFalse(/INSERT\s+INTO\s+.*schema_migrations/i.test(mig14));
  assertFalse(/DELETE\s+FROM\s+.*schema_migrations/i.test(mig14));
  assertEquals(stripped.includes("created_at ="), false);
  assertFalse(/https?:\/\//i.test(stripped));
  assertFalse(/dblink|postgres_fdw/i.test(stripped));
  assertEquals(
    mig14.includes(
      "REVOKE ALL ON FUNCTION public.get_driver_own_wallet_earning_rows(timestamptz, timestamptz) FROM PUBLIC, anon, service_role;",
    ),
    true,
  );
});

Deno.test("4D.2: corrective migration is enum-safe; historical 29120000 stays frozen", async () => {
  const historical = await Deno.readTextFile(
    new URL("../../migrations/20260929120000_driver_wallet_economic_earned_at.sql", import.meta.url),
  );
  const corrective = await Deno.readTextFile(
    new URL("../../migrations/20260929130000_driver_wallet_economic_earned_at_enum_safe.sql", import.meta.url),
  );
  const stripped = corrective.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assertEquals(historical.includes("AND upper(coalesce(purpose, '')) = 'RIDE_BOOKING'"), true);
  assertEquals(corrective.includes("AND upper(coalesce(purpose, '')) = 'RIDE_BOOKING'"), false);
  assertEquals(
    corrective.includes("AND purpose = 'RIDE_BOOKING'::public.payment_session_purpose"),
    false,
  );
  assertEquals(
    corrective.includes("AND ps.purpose = 'RIDE_BOOKING'::public.payment_session_purpose"),
    true,
  );
  assertEquals(corrective.includes("coalesce(purpose"), false);
  assertEquals(corrective.includes("coalesce(status, '')"), false);
  assertEquals(corrective.includes("upper(ps.status::text)"), true);
  assertEquals(corrective.includes("ps.purpose = 'RIDE_BOOKING'::public.payment_session_purpose"), true);
  assertEquals(corrective.includes("FROM public.payment_sessions ps"), true);
  assertEquals(corrective.includes("financial_model::text"), true);
  assertEquals(corrective.includes("SET search_path TO 'pg_catalog'"), true);
  assertFalse(corrective.includes("SET search_path TO 'public'"));
  assertFalse(/\bINSERT\s+INTO\b/i.test(stripped));
  assertFalse(/\bUPDATE\s+public\./i.test(stripped));
  assertFalse(/\bDELETE\s+FROM\b/i.test(stripped));
  assertEquals(
    corrective.includes(
      "REVOKE ALL ON FUNCTION public.get_driver_own_wallet_earning_rows(timestamptz, timestamptz) FROM PUBLIC, anon, service_role;",
    ),
    true,
  );
  assertEquals(
    corrective.includes(
      "REVOKE ALL ON FUNCTION public.driver_wallet_jwt_role() FROM PUBLIC, anon, authenticated, service_role;",
    ),
    true,
  );
});

Deno.test("lock: consume SSOT does not join payment_sessions; payout I/O stays isolated", async () => {
  const consume = await Deno.readTextFile(new URL("./economicEarnedAtSSOT.ts", import.meta.url));
  const payoutIo = await Deno.readTextFile(new URL("./fetchDriverPayoutEligibility.ts", import.meta.url));
  const payoutSsot = await Deno.readTextFile(new URL("./driverPayoutEligibilitySSOT.ts", import.meta.url));
  const loadFields = await Deno.readTextFile(new URL("./loadDriverWalletEconomicFields.ts", import.meta.url));
  assertFalse(consume.includes(".from(\"payment_sessions\")"));
  assertFalse(consume.includes("resolveCanonicalRideBookingCapture"));
  assertFalse(consume.includes("attachEconomicEarnedAt"));
  assertFalse(payoutIo.includes("economicEarnedAtSSOT"));
  assertEquals(payoutSsot.includes("DEFAULT_PAYOUT_CLEARING_DELAY_HOURS = 27"), true);
  assertEquals(loadFields.includes("driver_wallet_ledger_economic_fields"), true);
  assertFalse(loadFields.includes("from(\"payment_sessions\")"));
});

Deno.test("lock: Edge consumers no longer load payment_sessions evidence", async () => {
  const snapshot = await Deno.readTextFile(new URL("./fetchDriverWalletPayoutSnapshot.ts", import.meta.url));
  const summary = await Deno.readTextFile(new URL("./fetchDriverWalletSummary.ts", import.meta.url));
  const invoice = await Deno.readTextFile(new URL("./driverInvoiceAggregation.ts", import.meta.url));
  const earnings = await Deno.readTextFile(new URL("../driver-earnings-summary/index.ts", import.meta.url));
  for (const src of [snapshot, summary, invoice, earnings]) {
    assertFalse(src.includes("loadEconomicEarnedAtEvidence"));
    assertFalse(src.includes("attachEconomicEarnedAt"));
  }
});
