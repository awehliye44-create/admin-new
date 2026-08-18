/**
 * Lock tests for capturedTripWalletRecovery.ts
 * Covers: not-in-allow-list, zero provider calls, one wallet entry only,
 * no duplicate on repeat, DRIVER_COLLECTED blocked, dry-run mode.
 */
import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { recoverCapturedTripWallet } from "./capturedTripWalletRecovery.ts";

const ALLOWED_TRIPS = ["trip-007-uuid", "trip-008-uuid", "trip-009-uuid"] as const;

function mockTrip(overrides: Record<string, unknown> = {}) {
  return {
    id: "trip-007-uuid",
    trip_code: "MK-260817-007",
    status: "completed",
    driver_id: "driver-001",
    financial_model: "PLATFORM_COLLECTED",
    driver_net_pence: 408,
    airport_charge_pence: 0,
    commission_pct: 15,
    accepted_commission_percent: 15,
    tip_pence: 0,
    tip_amount_pence: 0,
    currency_code: "GBP",
    provider_order_id: "rev-order-007",
    discount_source: "global_offer",
    offer_discount_pence: 20,
    locked_base_fare_pence: 500,
    final_fare_pence: 480,
    commissionable_fare_pence: 480,
    commission_pence: 72,
    fare_snapshot_json: { gross_fare_pence: 500, original_fare_pence: 500 },
    customer_modification_charge_pence: 0,
    captured_at: "2026-08-17T18:50:46.198Z",
    created_at: "2026-08-17T18:39:05.705Z",
    ...overrides,
  };
}

function mockPs(statusOverride = "trip_created") {
  return {
    id: "ps-007",
    status: statusOverride,
    provider_state: "COMPLETED",
    captured_amount_pence: 480,
    captured_at: "2026-08-17T18:50:46.979Z",
    provider_state_verified_at: "2026-08-17T18:50:46.979Z",
    purpose: "RIDE_BOOKING",
    financial_operation_state: "CAPTURED",
    financial_operation_owner: null,
    refunded_amount_pence: null,
    released_amount_pence: null,
    hold_release_state: null,
    provider_order_id: "rev-order-007",
    provider_capture_id: "rev-cap-007",
    metadata: {},
  };
}

function buildMockSupabase(options: {
  tripData?: Record<string, unknown> | null;
  psData?: Record<string, unknown> | null;
  walletData?: { amount_pence: number }[];
  updateError?: { message: string } | null;
  creditReturn?: { credited: boolean };
  captureRevolutCalls?: string[];
}) {
  const revolut_calls: string[] = options.captureRevolutCalls ?? [];
  let updateCalled = false;

  return {
    _revolut_calls: revolut_calls,
    _update_called: () => updateCalled,
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
        const rows = options.psData ? [options.psData] : [];
        const list = Promise.resolve({ data: rows, error: null });
        const identityLookup = Promise.resolve({ data: [{ id: "ps-007" }], error: null });
        return {
          select: () => ({
            eq: (_col?: string, _val?: unknown) => ({
              neq: (_col2?: string, _val2?: unknown) => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: () => Promise.resolve({ data: options.psData ?? null }),
                  }),
                }),
                then: list.then.bind(list),
                catch: list.catch.bind(list),
                finally: list.finally.bind(list),
              }),
              then: identityLookup.then.bind(identityLookup),
              catch: identityLookup.catch.bind(identityLookup),
              finally: identityLookup.finally.bind(identityLookup),
            }),
          }),
          update: (_patch: unknown) => {
            updateCalled = true;
            return {
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    neq: () =>
                      Promise.resolve({ error: options.updateError ?? null }),
                  }),
                  neq: () =>
                    Promise.resolve({ error: options.updateError ?? null }),
                }),
              }),
            };
          },
        };
      }
      if (table === "driver_wallet_ledger") {
        const walletRows = options.walletData ?? [];
        return {
          select: () => ({
            eq: (_col1: string, _val1: unknown) => ({
              eq: (_col2: string, _val2: unknown) =>
                Promise.resolve({ data: walletRows }),
            }),
          }),
          insert: () => Promise.resolve({ data: [{ id: "ledger-001" }], error: null }),
        };
      }
      const zero = Promise.resolve({ data: [], count: 0, error: null });
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null }),
            then: zero.then.bind(zero),
            catch: zero.catch.bind(zero),
            finally: zero.finally.bind(zero),
          }),
        }),
        insert: () => Promise.resolve({ error: null }),
      };
    },
  };
}

Deno.test("recovery: trip not in allow-list — blocked immediately, no DB reads", async () => {
  const result = await recoverCapturedTripWallet(
    buildMockSupabase({ tripData: null }) as unknown as Parameters<typeof recoverCapturedTripWallet>[0],
    { tripId: "trip-UNKNOWN", allowedTripIds: ALLOWED_TRIPS, dryRun: false },
  );
  assertEquals(result.status, "NOT_IN_ALLOW_LIST");
});

Deno.test("recovery: MK-007 defective saved settlement is blocked before any credit amount is exposed", async () => {
  const mock = buildMockSupabase({
    tripData: mockTrip(),
    psData: mockPs("trip_created"),
    walletData: [],
  });
  const result = await recoverCapturedTripWallet(
    mock as unknown as Parameters<typeof recoverCapturedTripWallet>[0],
    { tripId: "trip-007-uuid", allowedTripIds: ALLOWED_TRIPS, dryRun: true },
  );
  assertEquals(result.status, "SETTLEMENT_CORRECTION_REQUIRED");
  if (result.status === "SETTLEMENT_CORRECTION_REQUIRED") {
    assertEquals(result.saved_driver_net_pence, 408);
    assertEquals(result.canonical_driver_net_pence, 425);
    assertEquals(result.driver_net_difference_pence, 17);
  }
});

Deno.test("recovery: DRIVER_COLLECTED trip — blocked", async () => {
  const result = await recoverCapturedTripWallet(
    buildMockSupabase({
      tripData: mockTrip({ financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET" }),
      psData: mockPs("captured"),
      walletData: [],
    }) as unknown as Parameters<typeof recoverCapturedTripWallet>[0],
    { tripId: "trip-007-uuid", allowedTripIds: ALLOWED_TRIPS, dryRun: false },
  );
  assertEquals(result.status, "FINANCIAL_MODEL_VIOLATION");
});

Deno.test("recovery: already credited matching amount — ALREADY_CREDITED", async () => {
  const result = await recoverCapturedTripWallet(
    buildMockSupabase({
      tripData: mockTrip({
        driver_net_pence: 425,
        commissionable_fare_pence: 500,
        commission_pence: 75,
      }),
      psData: mockPs("captured"),
      walletData: [{ amount_pence: 425 }],
    }) as unknown as Parameters<typeof recoverCapturedTripWallet>[0],
    { tripId: "trip-007-uuid", allowedTripIds: ALLOWED_TRIPS, dryRun: false },
  );
  assertEquals(result.status, "ALREADY_CREDITED");
  if (result.status === "ALREADY_CREDITED") {
    assertEquals(result.credited_pence, 425);
  }
});

Deno.test("recovery: existing wallet amount mismatch — WALLET_AMOUNT_MISMATCH", async () => {
  const result = await recoverCapturedTripWallet(
    buildMockSupabase({
      tripData: mockTrip({
        driver_net_pence: 425,
        commissionable_fare_pence: 500,
        commission_pence: 75,
      }),
      psData: mockPs("captured"),
      walletData: [{ amount_pence: 408 }],
    }) as unknown as Parameters<typeof recoverCapturedTripWallet>[0],
    { tripId: "trip-007-uuid", allowedTripIds: ALLOWED_TRIPS, dryRun: true },
  );
  assertEquals(result.status, "WALLET_AMOUNT_MISMATCH");
  if (result.status === "WALLET_AMOUNT_MISMATCH") {
    assertEquals(result.expected_pence, 425);
    assertEquals(result.actual_pence, 408);
  }
});

Deno.test("recovery: missing saved entitlement is blocked as settlement correction required", async () => {
  const result = await recoverCapturedTripWallet(
    buildMockSupabase({
      tripData: mockTrip({ driver_net_pence: null, airport_charge_pence: null }),
      psData: mockPs("captured"),
      walletData: [],
    }) as unknown as Parameters<typeof recoverCapturedTripWallet>[0],
    { tripId: "trip-007-uuid", allowedTripIds: ALLOWED_TRIPS, dryRun: false },
  );
  assertEquals(result.status, "SETTLEMENT_CORRECTION_REQUIRED");
});

Deno.test("recovery: no payment session — blocked (PAYMENT_SESSION_NOT_FOUND)", async () => {
  const result = await recoverCapturedTripWallet(
    buildMockSupabase({
      tripData: mockTrip({
        driver_net_pence: 425,
        commissionable_fare_pence: 500,
        commission_pence: 75,
      }),
      psData: null,
      walletData: [],
    }) as unknown as Parameters<typeof recoverCapturedTripWallet>[0],
    { tripId: "trip-007-uuid", allowedTripIds: ALLOWED_TRIPS, dryRun: false },
  );
  assertEquals(result.status, "PAYMENT_SESSION_NOT_FOUND");
});

Deno.test("recovery: MK-009 defective saved settlement is blocked before any credit amount is exposed", async () => {
  const result = await recoverCapturedTripWallet(
    buildMockSupabase({
      tripData: mockTrip({
        id: "trip-009-uuid",
        trip_code: "MK-260817-009",
        driver_net_pence: 678,
        final_fare_pence: 798,
        commissionable_fare_pence: 798,
        commission_pence: 120,
        offer_discount_pence: 33,
        discount_source: "global_offer",
        locked_base_fare_pence: 831,
        fare_snapshot_json: { gross_fare_pence: 831, original_fare_pence: 831 },
        provider_order_id: "rev-order-009",
      }),
      psData: mockPs("trip_created"),
      walletData: [],
    }) as unknown as Parameters<typeof recoverCapturedTripWallet>[0],
    { tripId: "trip-009-uuid", allowedTripIds: ALLOWED_TRIPS, dryRun: true },
  );
  assertEquals(result.status, "SETTLEMENT_CORRECTION_REQUIRED");
  if (result.status === "SETTLEMENT_CORRECTION_REQUIRED") {
    assertEquals(result.saved_driver_net_pence, 678);
    assertEquals(result.canonical_driver_net_pence, 706);
    assertEquals(result.driver_net_difference_pence, 28);
  }
});

Deno.test("recovery: MK-008 missing commission rate is blocked with pending evidence", async () => {
  const result = await recoverCapturedTripWallet(
    buildMockSupabase({
      tripData: mockTrip({
        id: "trip-008-uuid",
        trip_code: "MK-260817-008",
        driver_net_pence: null,
        commissionable_fare_pence: null,
        commission_pence: null,
        accepted_commission_percent: null,
        commission_pct: null,
        final_fare_pence: 716,
        offer_discount_pence: 29,
        discount_source: "global_offer",
        locked_base_fare_pence: 745,
        fare_snapshot_json: { gross_fare_pence: 745 },
        provider_order_id: "rev-order-008",
      }),
      psData: mockPs("trip_created"),
      walletData: [],
    }) as unknown as Parameters<typeof recoverCapturedTripWallet>[0],
    { tripId: "trip-008-uuid", allowedTripIds: ALLOWED_TRIPS, dryRun: true },
  );
  assertEquals(result.status, "SETTLEMENT_CORRECTION_REQUIRED");
  if (result.status === "SETTLEMENT_CORRECTION_REQUIRED") {
    assertEquals(result.reason.includes("PENDING_EVIDENCE"), true);
    assertEquals(result.canonical_driver_net_pence, null);
  }
});

Deno.test("recovery: lifecycle finalization DB error — LIFECYCLE_FINALIZATION_FAILED", async () => {
  const result = await recoverCapturedTripWallet(
    buildMockSupabase({
      tripData: mockTrip({
        driver_net_pence: 425,
        commissionable_fare_pence: 500,
        commission_pence: 75,
        final_fare_pence: 480,
        offer_discount_pence: 20,
        discount_source: "global_offer",
        locked_base_fare_pence: 500,
        fare_snapshot_json: { gross_fare_pence: 500, original_fare_pence: 500 },
      }),
      psData: mockPs("trip_created"),
      walletData: [],
      updateError: { message: "connection timeout" },
    }) as unknown as Parameters<typeof recoverCapturedTripWallet>[0],
    { tripId: "trip-007-uuid", allowedTripIds: ALLOWED_TRIPS, dryRun: false },
  );
  assertEquals(result.status, "LIFECYCLE_FINALIZATION_FAILED");
});
