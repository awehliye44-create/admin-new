/**
 * Step 8.2A.1 — executable behavioural tests for adminCaptureTripPaymentSSOT.
 *
 * Run:
 *   deno test --allow-read --no-check supabase/functions/_shared/adminCaptureTripPaymentSSOT.test.ts
 */
import { assertEquals, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { executeAdminCaptureTripPayment } from "./adminCaptureTripPaymentSSOT.ts";
import { PAYMENT_SESSION_GATE_STATUS, PAYMENT_SESSION_PURPOSE_RIDE_BOOKING } from "./paymentSessionCaptureGateSSOT.ts";
import { postingBalanced, postingWalletMismatch } from "./postCaptureSettlementResult.ts";
import { FINANCIAL_MODEL_VIOLATION, SERVICE_AREA_FINANCIAL_MODEL } from "./commissionWalletSSOT.ts";
import { ADMIN_CAPTURE_PRECONDITION } from "./adminCaptureTripPaymentPreconditions.ts";

const BASE_TRIP: Record<string, unknown> = {
  id: "trip-1",
  status: "completed",
  financial_model: "PLATFORM_COLLECTED",
  driver_id: "driver-1",
  provider_order_id: "order-1",
  client_action_id: "ca-1",
  final_customer_fare_pence: 500,
  final_fare_pence: 500,
  commissionable_fare_pence: 500,
  commission_pence: 75,
  driver_net_pence: 425,
  settlement_formula_version: "2",
  authorised_amount_pence: 500,
  trip_code: "MK-TEST-001",
};

type Op = { table: string; op: string; payload?: Record<string, unknown> };

function psRow(extra: Record<string, unknown> = {}) {
  return {
    id: "ps-book",
    trip_id: "trip-1",
    purpose: PAYMENT_SESSION_PURPOSE_RIDE_BOOKING,
    provider_order_id: "order-1",
    status: "trip_created",
    provider_state: "AUTHORISED",
    metadata: {},
    financial_operation_state: "IDLE",
    ...extra,
  };
}

function buildMockSupabase(sessions: Record<string, unknown>[]) {
  const ops: Op[] = [];
  let psRows = sessions.map((s) => ({ ...s }));

  const client = {
    from(table: string) {
      const state: { filters: Record<string, unknown> } = { filters: {} };
      const chain: Record<string, unknown> = {
        select(_cols: string) { return chain; },
        eq(col: string, val: unknown) {
          state.filters[col] = val;
          return chain;
        },
        neq() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        insert(payload: Record<string, unknown>) {
          ops.push({ table, op: "insert", payload });
          return Promise.resolve({ error: null });
        },
        update(payload: Record<string, unknown>) {
          ops.push({ table, op: "update", payload });
          if (table === "payment_sessions" && state.filters.id) {
            const idx = psRows.findIndex((r) => r.id === state.filters.id);
            if (idx >= 0) psRows[idx] = { ...psRows[idx], ...payload };
          }
          const upd = {
            eq() { return upd; },
            then(resolve: (v: unknown) => unknown) {
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return upd;
        },
        then(resolve: (v: { data: unknown; error: null }) => unknown) {
          if (table === "payment_sessions") {
            const rows = psRows.filter((r) =>
              (state.filters.trip_id ? r.trip_id === state.filters.trip_id : true)
              && (state.filters.purpose ? r.purpose === state.filters.purpose : true),
            );
            ops.push({ table, op: "select", payload: { filters: { ...state.filters }, count: rows.length } });
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          }
          if (table === "driver_wallet_ledger") {
            const rows = ops.filter((o) => o.table === "driver_wallet_ledger" && o.op === "insert");
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
      };
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
  };

  return {
    client,
    ops,
    getPsRows: () => psRows,
    setPsRows: (rows: Record<string, unknown>[]) => { psRows = rows; },
  };
}

function baseDeps(metrics: {
  retrieve: number;
  capture: number;
  persist: number;
  settlement: number;
  lockClaim: number;
  lockRelease: number;
  psCaptured: boolean;
}) {
  return {
    resolveMerchant: async () => ({ environment: "sandbox", secretKey: "sk" }),
    retrieveOrder: async () => {
      metrics.retrieve += 1;
      return { state: "AUTHORISED", amount: 500, id: "order-1" };
    },
    captureOrder: async () => {
      metrics.capture += 1;
      return { state: "COMPLETED", amount: 500, id: "cap-1" };
    },
    persistConfirmedCapture: async () => {
      metrics.persist += 1;
      metrics.psCaptured = true;
      return { applied: true, reason: "persisted", captured_amount_pence: 500, provider_fee_pence: null, classification: "CAPTURE_COMPLETE" };
    },
    applySettlement: async () => {
      metrics.settlement += 1;
      return postingBalanced(425, 425);
    },
    claimLock: async () => {
      metrics.lockClaim += 1;
      return { ok: true as const, owner: "admin-capture:trip-1", state: "CAPTURING" as const };
    },
    releaseLock: async () => {
      metrics.lockRelease += 1;
      return { ok: true as const };
    },
  };
}

Deno.test("A: completed + AUTHORIZED — lock, retrieve×1, capture×1, persist×1, settlement×1", async () => {
  const { client } = buildMockSupabase([psRow()]);
  const m = { retrieve: 0, capture: 0, persist: 0, settlement: 0, lockClaim: 0, lockRelease: 0, psCaptured: false };
  const result = await executeAdminCaptureTripPayment({
    supabase: client as never,
    trip: BASE_TRIP,
    deps: baseDeps(m),
  });
  assertStrictEquals(result.success, true);
  assertStrictEquals(m.lockClaim, 1);
  assertStrictEquals(m.retrieve, 1);
  assertStrictEquals(m.capture, 1);
  assertStrictEquals(m.persist, 1);
  assertStrictEquals(m.settlement, 1);
  assertStrictEquals(m.psCaptured, true);
  assertStrictEquals(result.reconciliation_status, "BALANCED");
  assertStrictEquals(result.retry_provider_capture, false);
});

Deno.test("B: provider COMPLETED — retrieve×1, capture×0, persist reconcile, settlement×1", async () => {
  const { client } = buildMockSupabase([psRow()]);
  const m = { retrieve: 0, capture: 0, persist: 0, settlement: 0, lockClaim: 0, lockRelease: 0, psCaptured: false };
  const deps = baseDeps(m);
  deps.retrieveOrder = async () => {
    m.retrieve += 1;
    return { state: "COMPLETED", amount: 500, id: "order-1" };
  };
  const result = await executeAdminCaptureTripPayment({
    supabase: client as never,
    trip: BASE_TRIP,
    deps,
  });
  assertStrictEquals(result.success, true);
  assertStrictEquals(m.retrieve, 1);
  assertStrictEquals(m.capture, 0);
  assertStrictEquals(m.persist, 1);
  assertStrictEquals(m.settlement, 1);
});

Deno.test("C: incomplete trip — zero provider, zero persist, zero settlement", async () => {
  const { client } = buildMockSupabase([psRow()]);
  const m = { retrieve: 0, capture: 0, persist: 0, settlement: 0, lockClaim: 0, lockRelease: 0, psCaptured: false };
  const result = await executeAdminCaptureTripPayment({
    supabase: client as never,
    trip: { ...BASE_TRIP, status: "in_progress" },
    deps: baseDeps(m),
  });
  assertStrictEquals(result.success, false);
  assertStrictEquals(result.error_code, ADMIN_CAPTURE_PRECONDITION.TRIP_NOT_COMPLETED);
  assertStrictEquals(m.retrieve, 0);
  assertStrictEquals(m.capture, 0);
  assertStrictEquals(m.persist, 0);
  assertStrictEquals(m.settlement, 0);
  assertStrictEquals(m.lockClaim, 0);
});

Deno.test("D: missing settlement stamps — zero provider writes", async () => {
  const { client } = buildMockSupabase([psRow()]);
  const m = { retrieve: 0, capture: 0, persist: 0, settlement: 0, lockClaim: 0, lockRelease: 0, psCaptured: false };
  const result = await executeAdminCaptureTripPayment({
    supabase: client as never,
    trip: { ...BASE_TRIP, driver_net_pence: null, settlement_formula_version: null },
    deps: baseDeps(m),
  });
  assertStrictEquals(result.success, false);
  assertStrictEquals(result.error_code, ADMIN_CAPTURE_PRECONDITION.SETTLEMENT_STAMPS_INVALID);
  assertStrictEquals(m.retrieve, 0);
  assertStrictEquals(m.capture, 0);
  assertStrictEquals(m.persist, 0);
});

Deno.test("E: missing RIDE_BOOKING — PAYMENT_SESSION_MISSING, zero provider", async () => {
  const { client } = buildMockSupabase([]);
  const m = { retrieve: 0, capture: 0, persist: 0, settlement: 0, lockClaim: 0, lockRelease: 0, psCaptured: false };
  const result = await executeAdminCaptureTripPayment({
    supabase: client as never,
    trip: BASE_TRIP,
    deps: baseDeps(m),
  });
  assertStrictEquals(result.error_code, PAYMENT_SESSION_GATE_STATUS.PAYMENT_SESSION_MISSING);
  assertStrictEquals(m.retrieve, 0);
});

Deno.test("F: two RIDE_BOOKING — CAPTURE_AMBIGUOUS, zero provider", async () => {
  const { client } = buildMockSupabase([psRow({ id: "a" }), psRow({ id: "b" })]);
  const m = { retrieve: 0, capture: 0, persist: 0, settlement: 0, lockClaim: 0, lockRelease: 0, psCaptured: false };
  const result = await executeAdminCaptureTripPayment({
    supabase: client as never,
    trip: BASE_TRIP,
    deps: baseDeps(m),
  });
  assertStrictEquals(result.error_code, PAYMENT_SESSION_GATE_STATUS.CAPTURE_AMBIGUOUS);
  assertStrictEquals(m.retrieve, 0);
});

Deno.test("G: one RIDE_BOOKING only queried — recovery sibling not selected", async () => {
  const { client, ops } = buildMockSupabase([psRow()]);
  const m = { retrieve: 0, capture: 0, persist: 0, settlement: 0, lockClaim: 0, lockRelease: 0, psCaptured: false };
  await executeAdminCaptureTripPayment({
    supabase: client as never,
    trip: BASE_TRIP,
    deps: baseDeps(m),
  });
  const psSelect = ops.find((o) => o.table === "payment_sessions" && o.op === "select");
  assertEquals(psSelect?.payload?.filters?.purpose, PAYMENT_SESSION_PURPOSE_RIDE_BOOKING);
  assertStrictEquals(psSelect?.payload?.count, 1);
});

Deno.test("H: financial lock conflict — zero provider, zero persist", async () => {
  const { client } = buildMockSupabase([psRow()]);
  const m = { retrieve: 0, capture: 0, persist: 0, settlement: 0, lockClaim: 0, lockRelease: 0, psCaptured: false };
  const deps = baseDeps(m);
  deps.claimLock = async () => {
    m.lockClaim += 1;
    return { ok: false as const, reason: "busy" as const, currentState: "CAPTURING" as const, currentOwner: "other" };
  };
  const result = await executeAdminCaptureTripPayment({
    supabase: client as never,
    trip: BASE_TRIP,
    deps,
  });
  assertStrictEquals(result.error_code, "CAPTURE_BUSY");
  assertStrictEquals(m.retrieve, 0);
  assertStrictEquals(m.capture, 0);
  assertStrictEquals(m.persist, 0);
});

Deno.test("I: capture then wallet fail — capture×1, persist×1, retry COMPLETED capture×0", async () => {
  const { client } = buildMockSupabase([psRow()]);
  const m = { retrieve: 0, capture: 0, persist: 0, settlement: 0, lockClaim: 0, lockRelease: 0, psCaptured: false };
  const deps = baseDeps(m);
  deps.applySettlement = async () => postingWalletMismatch({ settlement_status: "FAILED", expectedPence: 425, postedPence: 0 });

  const first = await executeAdminCaptureTripPayment({ supabase: client as never, trip: BASE_TRIP, deps });
  assertStrictEquals(first.success, true);
  assertStrictEquals(first.reconciliation_status, "WALLET_MISMATCH");
  assertStrictEquals(first.retry_provider_capture, false);
  assertStrictEquals(m.capture, 1);

  deps.retrieveOrder = async () => {
    m.retrieve += 1;
    return { state: "COMPLETED", amount: 500, id: "order-1" };
  };
  deps.captureOrder = async () => {
    m.capture += 1;
    throw new Error("must not recapture");
  };
  const retry = await executeAdminCaptureTripPayment({ supabase: client as never, trip: BASE_TRIP, deps });
  assertStrictEquals(retry.success, true);
  assertStrictEquals(m.capture, 1);
});

Deno.test("J: DRIVER_COLLECTED — FINANCIAL_MODEL_VIOLATION, zero provider", async () => {
  const { client } = buildMockSupabase([psRow()]);
  const m = { retrieve: 0, capture: 0, persist: 0, settlement: 0, lockClaim: 0, lockRelease: 0, psCaptured: false };
  const result = await executeAdminCaptureTripPayment({
    supabase: client as never,
    trip: { ...BASE_TRIP, financial_model: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET },
    deps: baseDeps(m),
  });
  assertStrictEquals(result.error_code, FINANCIAL_MODEL_VIOLATION);
  assertStrictEquals(m.retrieve, 0);
});

Deno.test("K: capture amount mismatch — fail closed, zero provider", async () => {
  const { client } = buildMockSupabase([psRow()]);
  const m = { retrieve: 0, capture: 0, persist: 0, settlement: 0, lockClaim: 0, lockRelease: 0, psCaptured: false };
  const result = await executeAdminCaptureTripPayment({
    supabase: client as never,
    trip: BASE_TRIP,
    amountPence: 480,
    deps: baseDeps(m),
  });
  assertStrictEquals(result.error_code, ADMIN_CAPTURE_PRECONDITION.CAPTURE_AMOUNT_MISMATCH);
  assertStrictEquals(m.retrieve, 0);
});

Deno.test("ordering: fresh capture uses persistConfirmedProviderCapture only", async () => {
  const src = await Deno.readTextFile(new URL("./adminCaptureTripPaymentSSOT.ts", import.meta.url));
  assertStrictEquals(/import\s*\{[^}]*markPaymentSessionCaptured/.test(src), false);
  assertStrictEquals(src.includes("persistConfirmedProviderCapture"), true);
  const persistIdx = src.indexOf("await persistConfirmedCapture");
  const settlementIdx = src.indexOf("await applySettlement");
  assertStrictEquals(persistIdx >= 0 && settlementIdx > persistIdx, true);
});
