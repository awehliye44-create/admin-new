/**
 * Step 3A dry-run lock: allow-list MK-260818-002/003 only, 850p total,
 * blocked historical trips, no Revolut, saved stamps only, 27h eligibility origin.
 *
 * Run:
 *   deno test --allow-read --no-check supabase/functions/_shared/capturedTripWalletRecoveryLock.test.ts supabase/functions/_shared/capturedTripWalletRecoveryStep3aLock.test.ts
 */
import { assertEquals, assert } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  APPROVED_CAPTURED_TRIP_WALLET_RECOVERY_TRIP_IDS,
  recoverCapturedTripWallet,
} from "./capturedTripWalletRecovery.ts";
import { DEFAULT_PAYOUT_CLEARING_DELAY_HOURS } from "./driverPayoutEligibilitySSOT.ts";

const TRIP_002 = "3a575bad-ce3d-491e-998a-cd83fa5256ea";
const TRIP_003 = "7ada43fa-1f3d-43e8-979b-6152ba9d5f2c";
const TRIP_001 = "229223e3-c100-495d-afd8-2c39a3acf6b2";
const DRIVER = "cd8bae4c-3827-4b90-98c6-10be70eb0e52";
const ALLOW_LIST = APPROVED_CAPTURED_TRIP_WALLET_RECOVERY_TRIP_IDS;
const NOW_BEFORE_CLEARING = Date.parse("2026-08-18T14:30:00.000Z");

function approvedTrip(id: string, code: string, capturedAt: string) {
  return {
    id,
    trip_code: code,
    status: "completed",
    driver_id: DRIVER,
    financial_model: "PLATFORM_COLLECTED",
    driver_net_pence: 425,
    airport_charge_pence: 0,
    commission_pct: 15,
    accepted_commission_percent: 15,
    tip_pence: 0,
    tip_amount_pence: 0,
    currency: "GBP",
    currency_code: "gbp",
    provider_order_id: `order-${code}`,
    captured_at: capturedAt,
    discount_source: "global_offer",
    offer_discount_pence: 20,
    locked_base_fare_pence: 500,
    final_fare_pence: 480,
    commissionable_fare_pence: 500,
    commission_pence: 75,
    fare_snapshot_json: {
      gross_fare_pence: 500,
      original_fare_pence: 500,
      commission_after_promotion_pence: 55,
    },
    customer_modification_charge_pence: 0,
  };
}

function approvedPs(code: string, capturedAt: string) {
  return {
    id: `ps-${code}`,
    status: "captured",
    provider_state: "COMPLETED",
    captured_amount_pence: 480,
    captured_at: capturedAt,
    provider_state_verified_at: capturedAt,
    purpose: "RIDE_BOOKING",
    financial_operation_state: "CAPTURED",
    refunded_amount_pence: null,
    released_amount_pence: null,
    hold_release_state: null,
    provider_order_id: `order-${code}`,
    provider_capture_id: `cap-${code}`,
    metadata: {},
  };
}

function buildMock(options: {
  tripData?: Record<string, unknown> | null;
  psData?: Record<string, unknown> | null | Record<string, unknown>[];
  walletData?: { amount_pence: number }[];
  cwCount?: number;
  payoutCount?: number;
  ledgerStore?: { amount_pence: number }[];
}) {
  const ledger = options.ledgerStore ?? [...(options.walletData ?? [])];
  const psRows = Array.isArray(options.psData)
    ? options.psData
    : (options.psData ? [options.psData] : []);
  return {
    from: (table: string) => {
      if (table === "trips") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: options.tripData ?? null }),
            }),
          }),
        };
      }
      if (table === "payment_sessions") {
        const list = Promise.resolve({ data: psRows, error: null });
        return {
          select: () => ({
            eq: () => ({
              neq: () => ({
                then: list.then.bind(list),
                catch: list.catch.bind(list),
                finally: list.finally.bind(list),
              }),
            }),
          }),
          update: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({ neq: () => Promise.resolve({ error: { message: "no write in test" } }) }),
                neq: () => Promise.resolve({ error: { message: "no write in test" } }),
              }),
            }),
          }),
        };
      }
      if (table === "driver_wallet_ledger") {
        const selectEq = (_c1: string, _v1: unknown) => {
          const filtered = ledger;
          const result = Promise.resolve({ data: filtered, error: null, count: filtered.length });
          return {
            eq: (_c2: string, _v2: unknown) => result,
            maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null }),
            then: result.then.bind(result),
            catch: result.catch.bind(result),
            finally: result.finally.bind(result),
          };
        };
        return {
          select: () => ({ eq: selectEq }),
          insert: (row: { amount_pence: number }) => {
            if (ledger.some(() => true) && ledger.length >= 1 && options.ledgerStore) {
              const dup = ledger.find((r) => r);
              if (dup) return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate" } });
            }
            ledger.push({ amount_pence: row.amount_pence });
            return Promise.resolve({ data: [{ id: "ledger-new" }], error: null });
          },
        };
      }
      const count = table === "driver_commission_wallet_ledger"
        ? (options.cwCount ?? 0)
        : table === "payout_items"
        ? (options.payoutCount ?? 0)
        : 0;
      const zero = Promise.resolve({ data: [], count, error: null });
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null }),
            then: zero.then.bind(zero),
            catch: zero.catch.bind(zero),
            finally: zero.finally.bind(zero),
          }),
        }),
      };
    },
  };
}

Deno.test("allow-list is exactly MK-260818-002 and MK-260818-003", () => {
  assertEquals([...ALLOW_LIST], [TRIP_002, TRIP_003]);
});

Deno.test("MK-260818-002 dry-run eligible 425p from saved stamps", async () => {
  const capturedAt = "2026-08-18T10:52:08.848Z";
  const result = await recoverCapturedTripWallet(
    buildMock({
      tripData: approvedTrip(TRIP_002, "MK-260818-002", capturedAt),
      psData: approvedPs("MK-260818-002", capturedAt),
    }) as never,
    { tripId: TRIP_002, allowedTripIds: ALLOW_LIST, dryRun: true, nowMs: NOW_BEFORE_CLEARING },
  );
  assertEquals(result.status, "DRY_RUN_ELIGIBLE");
  if (result.status === "DRY_RUN_ELIGIBLE") {
    assertEquals(result.proposed_amount_pence, 425);
    assertEquals(result.proposed_ledger_type, "TRIP_EARNING_NET");
    assertEquals(result.currency, "GBP");
    assertEquals(result.proposed_related_trip_id, TRIP_002);
    assertEquals(result.driver_id, DRIVER);
    assertEquals(result.payment_session_id, "ps-MK-260818-002");
    assertEquals(result.provider_capture_id, "cap-MK-260818-002");
    assertEquals(result.captured_at, capturedAt);
    assertEquals(result.eligible_at, "2026-08-19T13:52:08.848Z");
    assertEquals(result.eligibility_classification, "Pending");
    assertEquals(result.provider_operation_required, false);
    assertEquals(result.settlement_recalculation_required, false);
    assertEquals(result.existing_wallet_count, 0);
  }
});

Deno.test("MK-260818-003 dry-run eligible 425p from saved stamps", async () => {
  const capturedAt = "2026-08-18T13:35:47.011Z";
  const result = await recoverCapturedTripWallet(
    buildMock({
      tripData: approvedTrip(TRIP_003, "MK-260818-003", capturedAt),
      psData: approvedPs("MK-260818-003", capturedAt),
    }) as never,
    { tripId: TRIP_003, allowedTripIds: ALLOW_LIST, dryRun: true, nowMs: NOW_BEFORE_CLEARING },
  );
  assertEquals(result.status, "DRY_RUN_ELIGIBLE");
  if (result.status === "DRY_RUN_ELIGIBLE") {
    assertEquals(result.proposed_amount_pence, 425);
    assertEquals(result.eligible_at, "2026-08-19T16:35:47.011Z");
    assertEquals(result.eligibility_classification, "Pending");
  }
});

Deno.test("approved pair totals 850p", async () => {
  let total = 0;
  for (const [id, code, capturedAt] of [
    [TRIP_002, "MK-260818-002", "2026-08-18T10:52:08.848Z"],
    [TRIP_003, "MK-260818-003", "2026-08-18T13:35:47.011Z"],
  ] as const) {
    const result = await recoverCapturedTripWallet(
      buildMock({
        tripData: approvedTrip(id, code, capturedAt),
        psData: approvedPs(code, capturedAt),
      }) as never,
      { tripId: id, allowedTripIds: ALLOW_LIST, dryRun: true, nowMs: NOW_BEFORE_CLEARING },
    );
    assertEquals(result.status, "DRY_RUN_ELIGIBLE");
    if (result.status === "DRY_RUN_ELIGIBLE") total += result.proposed_amount_pence;
  }
  assertEquals(total, 850);
});

Deno.test("unknown UUID blocked", async () => {
  const result = await recoverCapturedTripWallet(
    buildMock({ tripData: approvedTrip(TRIP_002, "MK-260818-002", "2026-08-18T10:52:08.848Z") }) as never,
    { tripId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", allowedTripIds: ALLOW_LIST, dryRun: true },
  );
  assertEquals(result.status, "NOT_IN_ALLOW_LIST");
});

Deno.test("MK-260818-001 defective settlement blocked even if listed", async () => {
  const result = await recoverCapturedTripWallet(
    buildMock({
      tripData: {
        ...approvedTrip(TRIP_001, "MK-260818-001", "2026-08-18T09:51:10.950Z"),
        id: TRIP_001,
        driver_net_pence: 408,
        commissionable_fare_pence: 480,
        commission_pence: 72,
      },
      psData: approvedPs("MK-260818-001", "2026-08-18T09:51:10.950Z"),
    }) as never,
    { tripId: TRIP_001, allowedTripIds: [TRIP_001], dryRun: true },
  );
  assertEquals(result.status, "SETTLEMENT_CORRECTION_REQUIRED");
});

Deno.test("MK-260817-007 defective settlement blocked", async () => {
  const result = await recoverCapturedTripWallet(
    buildMock({
      tripData: {
        ...approvedTrip("trip-007-uuid", "MK-260817-007", "2026-08-17T18:50:46.198Z"),
        id: "trip-007-uuid",
        driver_net_pence: 408,
        commissionable_fare_pence: 480,
        commission_pence: 72,
      },
    }) as never,
    { tripId: "trip-007-uuid", allowedTripIds: ["trip-007-uuid"], dryRun: true },
  );
  assertEquals(result.status, "SETTLEMENT_CORRECTION_REQUIRED");
});

Deno.test("MK-260817-008 missing commission rate blocked", async () => {
  const result = await recoverCapturedTripWallet(
    buildMock({
      tripData: {
        ...approvedTrip("trip-008-uuid", "MK-260817-008", "2026-08-17T18:51:49.765Z"),
        id: "trip-008-uuid",
        driver_net_pence: null,
        commissionable_fare_pence: null,
        commission_pence: null,
        accepted_commission_percent: null,
        commission_pct: null,
        driver_tier_commission_percent: null,
        locked_base_fare_pence: 745,
        offer_discount_pence: 29,
        final_fare_pence: 716,
      },
    }) as never,
    { tripId: "trip-008-uuid", allowedTripIds: ["trip-008-uuid"], dryRun: true },
  );
  assertEquals(result.status, "SETTLEMENT_CORRECTION_REQUIRED");
  if (result.status === "SETTLEMENT_CORRECTION_REQUIRED") {
    assertEquals(result.reason.includes("PENDING_EVIDENCE"), true);
  }
});

Deno.test("MK-260817-009 defective settlement blocked", async () => {
  const result = await recoverCapturedTripWallet(
    buildMock({
      tripData: {
        ...approvedTrip("trip-009-uuid", "MK-260817-009", "2026-08-17T19:27:14.313Z"),
        id: "trip-009-uuid",
        driver_net_pence: 678,
        commissionable_fare_pence: 798,
        commission_pence: 120,
        locked_base_fare_pence: 831,
        offer_discount_pence: 33,
        final_fare_pence: 798,
        fare_snapshot_json: { gross_fare_pence: 831, original_fare_pence: 831 },
      },
    }) as never,
    { tripId: "trip-009-uuid", allowedTripIds: ["trip-009-uuid"], dryRun: true },
  );
  assertEquals(result.status, "SETTLEMENT_CORRECTION_REQUIRED");
});

Deno.test("already credited matching amount is idempotent", async () => {
  const capturedAt = "2026-08-18T10:52:08.848Z";
  const result = await recoverCapturedTripWallet(
    buildMock({
      tripData: approvedTrip(TRIP_002, "MK-260818-002", capturedAt),
      psData: approvedPs("MK-260818-002", capturedAt),
      walletData: [{ amount_pence: 425 }],
    }) as never,
    { tripId: TRIP_002, allowedTripIds: ALLOW_LIST, dryRun: false },
  );
  assertEquals(result.status, "ALREADY_CREDITED");
});

Deno.test("duplicate existing rows block", async () => {
  const capturedAt = "2026-08-18T10:52:08.848Z";
  const result = await recoverCapturedTripWallet(
    buildMock({
      tripData: approvedTrip(TRIP_002, "MK-260818-002", capturedAt),
      walletData: [{ amount_pence: 425 }, { amount_pence: 425 }],
    }) as never,
    { tripId: TRIP_002, allowedTripIds: ALLOW_LIST, dryRun: true },
  );
  assertEquals(result.status, "DUPLICATE_WALLET_CREDIT");
});

Deno.test("refunded capture blocked", async () => {
  const capturedAt = "2026-08-18T10:52:08.848Z";
  const result = await recoverCapturedTripWallet(
    buildMock({
      tripData: approvedTrip(TRIP_002, "MK-260818-002", capturedAt),
      psData: { ...approvedPs("MK-260818-002", capturedAt), refunded_amount_pence: 480 },
    }) as never,
    { tripId: TRIP_002, allowedTripIds: ALLOW_LIST, dryRun: true },
  );
  assertEquals(result.status, "PAYMENT_SESSION_BLOCKED");
  if (result.status === "PAYMENT_SESSION_BLOCKED") {
    assertEquals(result.reason, "refund_exists");
  }
});

Deno.test("released capture blocked", async () => {
  const capturedAt = "2026-08-18T10:52:08.848Z";
  const result = await recoverCapturedTripWallet(
    buildMock({
      tripData: approvedTrip(TRIP_002, "MK-260818-002", capturedAt),
      psData: {
        ...approvedPs("MK-260818-002", capturedAt),
        released_amount_pence: 480,
        hold_release_state: "released",
      },
    }) as never,
    { tripId: TRIP_002, allowedTripIds: ALLOW_LIST, dryRun: true },
  );
  assertEquals(result.status, "PAYMENT_SESSION_BLOCKED");
  if (result.status === "PAYMENT_SESSION_BLOCKED") {
    assertEquals(result.reason, "release_contradiction");
  }
});

Deno.test("DRIVER_COLLECTED blocked", async () => {
  const capturedAt = "2026-08-18T10:52:08.848Z";
  const result = await recoverCapturedTripWallet(
    buildMock({
      tripData: {
        ...approvedTrip(TRIP_002, "MK-260818-002", capturedAt),
        financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
      },
      psData: approvedPs("MK-260818-002", capturedAt),
    }) as never,
    { tripId: TRIP_002, allowedTripIds: ALLOW_LIST, dryRun: true },
  );
  assertEquals(result.status, "FINANCIAL_MODEL_VIOLATION");
});

Deno.test("eligibility origin is original capture + 27h, not recovery time", () => {
  assertEquals(DEFAULT_PAYOUT_CLEARING_DELAY_HOURS, 27);
  const captured = Date.parse("2026-08-18T10:52:08.848Z");
  const eligible = captured + 27 * 3_600_000;
  assertEquals(new Date(eligible).toISOString(), "2026-08-19T13:52:08.848Z");
  assertEquals(eligible > NOW_BEFORE_CLEARING, true);
});

Deno.test("recovery source never calls Revolut and credits saved stamps only", async () => {
  const src = await Deno.readTextFile(new URL("./capturedTripWalletRecovery.ts", import.meta.url));
  assertEquals(/retrieveRevolutOrder|refundRevolutOrder|captureRevolut|revolutOrders/.test(src), false);
  assert(src.includes("saved stamps only"));
  const executeIdx = src.lastIndexOf("await creditCapturedCardTripLedger");
  assert(executeIdx > 0);
  const creditSlice = src.slice(executeIdx, executeIdx + 400);
  assert(creditSlice.includes("driverNetPence: expectedCredit"));
  assertEquals(creditSlice.includes("canonicalDriverNet"), false);
});

Deno.test("simulated execute inserts one TRIP_EARNING_NET 425p; repeat is idempotent via 23505 path", async () => {
  const capturedAt = "2026-08-18T10:52:08.848Z";
  const store: { amount_pence: number }[] = [];
  const mock = buildMock({
    tripData: approvedTrip(TRIP_002, "MK-260818-002", capturedAt),
    psData: approvedPs("MK-260818-002", capturedAt),
    ledgerStore: store,
  });
  const first = await recoverCapturedTripWallet(mock as never, {
    tripId: TRIP_002,
    allowedTripIds: ALLOW_LIST,
    dryRun: false,
  });
  assertEquals(first.status, "CREDITED");
  if (first.status === "CREDITED") assertEquals(first.credited_pence, 425);
  assertEquals(store.length, 1);
  assertEquals(store[0].amount_pence, 425);

  const second = await recoverCapturedTripWallet(mock as never, {
    tripId: TRIP_002,
    allowedTripIds: ALLOW_LIST,
    dryRun: false,
  });
  assertEquals(second.status, "ALREADY_CREDITED");
  assertEquals(store.length, 1);
});

Deno.test("unique partial index source lock exists", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260817140000_trip_earning_net_unique.sql", import.meta.url),
  );
  assert(sql.includes("driver_wallet_ledger_trip_earning_net_unique"));
  assert(sql.includes("WHERE type = 'TRIP_EARNING_NET'"));
});

Deno.test("ledger credit handles 23505 and forbids empty readback success", async () => {
  const src = await Deno.readTextFile(new URL("./onecabFinanceLedger.ts", import.meta.url));
  assert(src.includes('error.code !== "23505"'));
  assert(src.includes("WALLET_AMOUNT_MISMATCH"));
  assert(src.includes("DUPLICATE_WALLET_CREDIT"));
  assert(src.includes("WALLET_CREDIT_MISSING"));
  assert(src.includes("readTripEarningNetLedgerState"));
});

Deno.test("admin recovery function is dedicated, dry-run default, UUID-only, no Revolut", async () => {
  const src = await Deno.readTextFile(
    new URL("../admin-recover-captured-trip-wallet/handler.ts", import.meta.url),
  );
  assert(src.includes("APPROVED_CAPTURED_TRIP_WALLET_RECOVERY_TRIP_IDS"));
  assert(src.includes("dry_run !== false"));
  assert(src.includes("COHORT_MODE_FORBIDDEN"));
  assert(src.includes("RECOVERY_AUDIT_REASON"));
  assert(src.includes("authenticateRecoverBearer"));
  assert(src.includes("auth.getUser"));
  assert(src.includes("super_admin"));
  assertEquals(/retrieveRevolutOrder|refundRevolutOrder|captureRevolut|revolutOrders/.test(src), false);
  assertEquals(src.includes("date_from"), true); // rejected key
  assert(src.includes("Cohort / date-range recovery is forbidden"));
});
