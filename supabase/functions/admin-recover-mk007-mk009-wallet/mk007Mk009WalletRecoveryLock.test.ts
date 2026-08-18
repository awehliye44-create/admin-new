/**
 * Recovery, saved-stamp, economic-date, idempotency, and schema locks
 * for admin-recover-mk007-mk009-wallet.
 *
 * Run:
 *   deno test --allow-read --no-check supabase/functions/admin-recover-mk007-mk009-wallet/mk007Mk009WalletRecoveryLock.test.ts
 */
import { assertEquals, assert } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  APPROVED_DRIVER_ID,
  APPROVED_MK007_MK009_TRIP_IDS,
  EXPECTED_STAMPS,
  MK007_ID,
  MK008_ID,
  MK009_ID,
  PAYOUT_CLEARING_DELAY_HOURS,
  addHoursIso,
  evaluateMk007Mk009DryRun,
  londonCivilDateKey,
  recoverMk007Mk009WalletDryRun,
  stampMatchesExpected,
} from "./mk007Mk009WalletRecovery.ts";

function thenable(result: unknown) {
  const p = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    eq: () => chain,
    maybeSingle: () => p,
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    finally: p.finally.bind(p),
  };
  return chain;
}

function mockTrip(id: string, overrides: Record<string, unknown> = {}) {
  const expected = EXPECTED_STAMPS[id];
  return {
    id,
    trip_code: expected.trip_code,
    status: "completed",
    driver_id: APPROVED_DRIVER_ID,
    financial_model: "PLATFORM_COLLECTED",
    driver_net_pence: expected.driver_net_pence,
    airport_charge_pence: 0,
    commission_pct: 15,
    accepted_commission_percent: 15,
    commissionable_fare_pence: expected.commissionable_fare_pence,
    commission_pence: expected.commission_pence,
    final_fare_pence: expected.final_fare_pence,
    offer_discount_pence: expected.applied_customer_promotion_pence,
    fare_snapshot_json: {
      applied_customer_promotion_pence: expected.applied_customer_promotion_pence,
      commission_after_promotion_pence: expected.commission_after_promotion_pence,
    },
    currency_code: "GBP",
    currency: "GBP",
    ...overrides,
  };
}

function mockPs(id: string, overrides: Record<string, unknown> = {}) {
  const expected = EXPECTED_STAMPS[id];
  const capturedAt = id === MK007_ID
    ? "2026-08-17T18:50:46.198+00"
    : "2026-08-17T19:27:16.212+00";
  return {
    id: id === MK007_ID ? "fa09be43-0029-4d29-9437-d0ffd79e2f82" : "d5580338-b518-4abb-bbdc-3b4ce639b2f7",
    trip_id: id,
    purpose: "RIDE_BOOKING",
    status: "trip_created",
    provider_state: "COMPLETED",
    provider_state_verified_at: capturedAt,
    captured_amount_pence: expected.captured_amount_pence,
    captured_at: capturedAt,
    provider_order_id: `ord-${id}`,
    provider_capture_id: `cap-${id}`,
    refunded_amount_pence: null,
    released_amount_pence: null,
    hold_release_state: null,
    financial_operation_state: "CAPTURED",
    provider_refund_id: null,
    released_at: null,
    refunded_at: null,
    ...overrides,
  };
}

function buildMockSupabase(options: {
  tripData?: Record<string, unknown> | null;
  sessions?: Record<string, unknown>[];
  ledger?: Array<{ amount_pence?: number; type?: string }>;
  cwCount?: number;
  payoutCount?: number;
  queryError?: string;
}) {
  let writes = 0;
  return {
    writes: () => writes,
    from: (table: string) => {
      const mutating = {
        insert: () => {
          writes += 1;
          return Promise.resolve({ error: new Error("writes forbidden") });
        },
        update: () => {
          writes += 1;
          return { eq: () => Promise.resolve({ error: new Error("writes forbidden") }) };
        },
        delete: () => {
          writes += 1;
          return { eq: () => Promise.resolve({ error: new Error("writes forbidden") }) };
        },
      };
      if (table === "trips") {
        return {
          ...mutating,
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: options.tripData ?? null, error: null }),
            }),
          }),
        };
      }
      if (table === "payment_sessions") {
        return {
          ...mutating,
          select: () => thenable({
            data: options.sessions ?? [],
            error: options.queryError === "ps" ? { message: "ps failed" } : null,
          }),
        };
      }
      if (table === "driver_wallet_ledger") {
        return {
          ...mutating,
          select: () => thenable({
            data: options.ledger ?? [],
            error: options.queryError === "wallet" ? { message: "wallet failed" } : null,
          }),
        };
      }
      if (table === "driver_commission_wallet_ledger") {
        return {
          ...mutating,
          select: () => thenable({
            data: [],
            count: options.cwCount ?? 0,
            error: options.queryError === "cw" ? { message: "cw failed" } : null,
          }),
        };
      }
      if (table === "payout_items") {
        return {
          ...mutating,
          select: () => thenable({
            data: [],
            count: options.payoutCount ?? 0,
            error: options.queryError === "payout" ? { message: "payout failed" } : null,
          }),
        };
      }
      return {
        ...mutating,
        select: () => thenable({ data: [], count: 0, error: null }),
      };
    },
  };
}

function eligibleInput(id: string) {
  return {
    tripId: id,
    trip: mockTrip(id),
    sessions: [mockPs(id)],
    tenRows: [] as Array<{ amount_pence?: unknown }>,
    commissionWalletCount: 0,
    payoutItemCount: 0,
  };
}

Deno.test("allow-list is exactly MK-007 and MK-009", () => {
  assertEquals([...APPROVED_MK007_MK009_TRIP_IDS], [MK007_ID, MK009_ID]);
  assertEquals(PAYOUT_CLEARING_DELAY_HOURS, 27);
});

Deno.test("saved stamps match expected identity 425+55=480 and 706+92=798", () => {
  assertEquals(stampMatchesExpected(mockTrip(MK007_ID), EXPECTED_STAMPS[MK007_ID]), null);
  assertEquals(stampMatchesExpected(mockTrip(MK009_ID), EXPECTED_STAMPS[MK009_ID]), null);
  assertEquals(EXPECTED_STAMPS[MK007_ID].driver_net_pence + EXPECTED_STAMPS[MK007_ID].commission_after_promotion_pence, 480);
  assertEquals(EXPECTED_STAMPS[MK009_ID].driver_net_pence + EXPECTED_STAMPS[MK009_ID].commission_after_promotion_pence, 798);
});

Deno.test("MK-007 dry-run eligible 425p with 17 Aug economic date", () => {
  const result = evaluateMk007Mk009DryRun(eligibleInput(MK007_ID));
  assertEquals(result.status, "DRY_RUN_ELIGIBLE");
  if (result.status !== "DRY_RUN_ELIGIBLE") return;
  assertEquals(result.proposed_amount_pence, 425);
  assertEquals(result.saved_driver_entitlement_pence, 425);
  assertEquals(result.existing_wallet_count, 0);
  assertEquals(result.existing_wallet_amount_pence, 0);
  assertEquals(result.provider_operation_required, false);
  assertEquals(result.settlement_recalculation_required, false);
  assertEquals(result.posting_created_at, null);
  assertEquals(result.posting_created_at_projection, "future_execution_timestamp");
  assertEquals(londonCivilDateKey(result.economic_earned_at), "2026-08-17");
  assertEquals(result.eligible_at, addHoursIso(result.economic_earned_at, 27));
  assertEquals(result.eligibility_origin, "captured_at_plus_27h");
  assertEquals(result.payment_session_lifecycle_mismatch, true);
  assertEquals(result.payment_session_status, "trip_created");
});

Deno.test("MK-009 dry-run eligible 706p with 17 Aug economic date", () => {
  const result = evaluateMk007Mk009DryRun(eligibleInput(MK009_ID));
  assertEquals(result.status, "DRY_RUN_ELIGIBLE");
  if (result.status !== "DRY_RUN_ELIGIBLE") return;
  assertEquals(result.proposed_amount_pence, 706);
  assertEquals(londonCivilDateKey(result.economic_earned_at), "2026-08-17");
  assertEquals(londonCivilDateKey(result.economic_earned_at) === "2026-08-18", false);
});

Deno.test("18 Aug is not the attribution civil date for either trip", () => {
  const a = evaluateMk007Mk009DryRun(eligibleInput(MK007_ID));
  const b = evaluateMk007Mk009DryRun(eligibleInput(MK009_ID));
  if (a.status === "DRY_RUN_ELIGIBLE") {
    assertEquals(londonCivilDateKey(a.economic_earned_at), "2026-08-17");
  }
  if (b.status === "DRY_RUN_ELIGIBLE") {
    assertEquals(londonCivilDateKey(b.economic_earned_at), "2026-08-17");
  }
});

Deno.test("MK-008 and unknown UUID are not in allow-list", () => {
  assertEquals(
    evaluateMk007Mk009DryRun({
      ...eligibleInput(MK007_ID),
      tripId: MK008_ID,
    }).status,
    "NOT_IN_ALLOW_LIST",
  );
  assertEquals(
    evaluateMk007Mk009DryRun({
      ...eligibleInput(MK007_ID),
      tripId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    }).status,
    "NOT_IN_ALLOW_LIST",
  );
});

Deno.test("saved stamp mismatch fails closed and does not expose a credit", () => {
  const result = evaluateMk007Mk009DryRun({
    ...eligibleInput(MK007_ID),
    trip: mockTrip(MK007_ID, { driver_net_pence: 408 }),
  });
  assertEquals(result.status, "SETTLEMENT_STAMP_MISMATCH");
  assertEquals("proposed_amount_pence" in result, false);
});

Deno.test("existing matching TEN is ALREADY_CREDITED and does not expose a new credit", () => {
  const result = evaluateMk007Mk009DryRun({
    ...eligibleInput(MK007_ID),
    tenRows: [{ amount_pence: 425 }],
  });
  assertEquals(result.status, "ALREADY_CREDITED");
  if (result.status === "ALREADY_CREDITED") {
    assertEquals(result.credited_pence, 425);
  }
  assertEquals("proposed_amount_pence" in result, false);
});

Deno.test("existing wrong TEN amount is WALLET_AMOUNT_MISMATCH", () => {
  const result = evaluateMk007Mk009DryRun({
    ...eligibleInput(MK007_ID),
    tenRows: [{ amount_pence: 400 }],
  });
  assertEquals(result.status, "WALLET_AMOUNT_MISMATCH");
});

Deno.test("duplicate TEN rows are blocked", () => {
  const result = evaluateMk007Mk009DryRun({
    ...eligibleInput(MK007_ID),
    tenRows: [{ amount_pence: 425 }, { amount_pence: 425 }],
  });
  assertEquals(result.status, "DUPLICATE_WALLET_CREDIT");
});

Deno.test("wrong driver ownership is blocked", () => {
  const result = evaluateMk007Mk009DryRun({
    ...eligibleInput(MK007_ID),
    trip: mockTrip(MK007_ID, { driver_id: "00000000-0000-4000-8000-000000000000" }),
  });
  assertEquals(result.status, "DRIVER_MISMATCH");
});

Deno.test("Commission Wallet or payout item presence is blocked", () => {
  assertEquals(
    evaluateMk007Mk009DryRun({ ...eligibleInput(MK007_ID), commissionWalletCount: 1 }).status,
    "MODEL_ISOLATION_BLOCKED",
  );
  assertEquals(
    evaluateMk007Mk009DryRun({ ...eligibleInput(MK007_ID), payoutItemCount: 1 }).status,
    "MODEL_ISOLATION_BLOCKED",
  );
});

Deno.test("PAYMENT_RECOVERY session blocks dry-run", () => {
  const result = evaluateMk007Mk009DryRun({
    ...eligibleInput(MK007_ID),
    sessions: [mockPs(MK007_ID, { purpose: "PAYMENT_RECOVERY" })],
  });
  assertEquals(result.status, "PAYMENT_SESSION_BLOCKED");
});

Deno.test("refund or release evidence blocks dry-run", () => {
  assertEquals(
    evaluateMk007Mk009DryRun({
      ...eligibleInput(MK007_ID),
      sessions: [mockPs(MK007_ID, { refunded_amount_pence: 10 })],
    }).status,
    "PAYMENT_SESSION_BLOCKED",
  );
  assertEquals(
    evaluateMk007Mk009DryRun({
      ...eligibleInput(MK007_ID),
      sessions: [mockPs(MK007_ID, { hold_release_state: "RELEASED" })],
    }).status,
    "PAYMENT_SESSION_BLOCKED",
  );
});

Deno.test("async recover: both approved UUIDs total 1131p and perform no writes", async () => {
  const mock007 = buildMockSupabase({
    tripData: mockTrip(MK007_ID),
    sessions: [mockPs(MK007_ID)],
  });
  const mock009 = buildMockSupabase({
    tripData: mockTrip(MK009_ID),
    sessions: [mockPs(MK009_ID)],
  });
  const a = await recoverMk007Mk009WalletDryRun(mock007 as never, MK007_ID);
  const b = await recoverMk007Mk009WalletDryRun(mock009 as never, MK009_ID);
  assertEquals(a.status, "DRY_RUN_ELIGIBLE");
  assertEquals(b.status, "DRY_RUN_ELIGIBLE");
  const total = (a.status === "DRY_RUN_ELIGIBLE" ? a.proposed_amount_pence : 0)
    + (b.status === "DRY_RUN_ELIGIBLE" ? b.proposed_amount_pence : 0);
  assertEquals(total, 1131);
  assertEquals(mock007.writes(), 0);
  assertEquals(mock009.writes(), 0);
});

Deno.test("async recover: MK-008 never reads a credit path", async () => {
  const mock = buildMockSupabase({ tripData: mockTrip(MK007_ID) });
  const result = await recoverMk007Mk009WalletDryRun(mock as never, MK008_ID);
  assertEquals(result.status, "NOT_IN_ALLOW_LIST");
});

Deno.test("async recover: wrong ledger type is isolation-blocked", async () => {
  const mock = buildMockSupabase({
    tripData: mockTrip(MK007_ID),
    sessions: [mockPs(MK007_ID)],
    ledger: [{ amount_pence: 425, type: "ADJUSTMENT" }],
  });
  const result = await recoverMk007Mk009WalletDryRun(mock as never, MK007_ID);
  assertEquals(result.status, "MODEL_ISOLATION_BLOCKED");
});

Deno.test("schema lock: no provider/FR/payout writer/settlement calc/wallet write", async () => {
  const files = [
    "index.ts",
    "handler.ts",
    "mk007Mk009WalletRecovery.ts",
    "recoverAuth.ts",
  ];
  for (const name of files) {
    const src = await Deno.readTextFile(new URL(`./${name}`, import.meta.url));
    assertEquals(src.includes("revolutOrders"), false, name);
    assertEquals(src.includes("retrieveRevolutOrder"), false, name);
    assertEquals(/from ["'].*revolut/i.test(src), false, name);
    assertEquals(src.includes("creditCapturedCardTripLedger"), false, name);
    assertEquals(src.includes("calculateTripSettlementFromTripRow"), false, name);
    assertEquals(src.includes("classifyFrPromotionApplication"), false, name);
    assertEquals(src.includes("finalizePaymentSessionLifecycleMismatch"), false, name);
    assertEquals(src.includes("capturedTripWalletRecovery"), false, name);
    assertEquals(src.includes("frPerTripAuditSSOT"), false, name);
    assertEquals(src.includes("applyCanonicalSettlementAfterCapture"), false, name);
    assertEquals(src.includes(".insert("), false, name);
    assertEquals(src.includes(".update("), false, name);
    assertEquals(src.includes(".delete("), false, name);
    assertEquals(src.includes("CREDIT_SAVED_TRIP_EARNING_NET"), false, name);
  }
});

Deno.test("schema lock: unique TEN index migration remains", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260817140000_trip_earning_net_unique.sql", import.meta.url),
  );
  assert(sql.includes("driver_wallet_ledger_trip_earning_net_unique"));
  assert(sql.includes("WHERE type = 'TRIP_EARNING_NET'"));
});

Deno.test("schema lock: SQL economic-date head 20260929140000 remains", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260929140000_driver_wallet_economic_earned_at_return_types.sql", import.meta.url),
  );
  assert(sql.includes("get_driver_own_wallet_earning_rows"));
  const consumers = [
    "../admin-driver-wallet-ssot/index.ts",
    "../admin-continuous-reconciliation/index.ts",
    "../driver-earnings-summary/index.ts",
    "../admin-driver-invoice/index.ts",
    "../auto-generate-statements/index.ts",
  ];
  for (const rel of consumers) {
    const src = await Deno.readTextFile(new URL(rel, import.meta.url));
    assertEquals(src.length > 0, true, rel);
  }
});

Deno.test("schema lock: Driver app still uses get_driver_own_wallet_earning_rows", async () => {
  const src = await Deno.readTextFile(
    new URL("../../../../ONECAB/onecab-driver-native/src/features/earnings/data/fetchOwnWalletEarningRows.ts", import.meta.url),
  );
  assert(src.includes("get_driver_own_wallet_earning_rows"));
});
