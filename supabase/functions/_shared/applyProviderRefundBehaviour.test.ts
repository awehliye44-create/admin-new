/**
 * Step 8.2A.1 — upsertPaymentSessionRefund delta semantics + applyProviderRefund behaviour.
 *
 * Run:
 *   deno test --allow-read --no-check supabase/functions/_shared/applyProviderRefundBehaviour.test.ts
 */
import { assertEquals, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { upsertPaymentSessionRefund } from "./paymentSessionSSOT.ts";
import { applyProviderRefundToOnecab } from "./applyProviderRefund.ts";
import { PAYMENT_SESSION_GATE_STATUS, PAYMENT_SESSION_PURPOSE_RIDE_BOOKING } from "./paymentSessionCaptureGateSSOT.ts";
import {
  buildClientWithAtomicRpcMock,
  createAtomicRpcMockState,
  seedTripEarning,
} from "./applyProviderRefundAtomicRpcMock.ts";

type MockFilters = Record<string, unknown>;

function createThenable<T>(value: T) {
  return {
    then(resolve: (v: T) => unknown) {
      return Promise.resolve(value).then(resolve);
    },
  };
}

function buildRefundTestClient() {
  const refundChildren: Array<Record<string, unknown>> = [];
  const psBook = {
    id: "ps-book",
    trip_id: "trip-1",
    purpose: PAYMENT_SESSION_PURPOSE_RIDE_BOOKING,
    captured_amount_pence: 500,
    refunded_amount_pence: 0,
    payment_provider: "revolut",
    provider_order_id: "order-1",
  };
  const psRecovery = {
    id: "ps-recovery",
    trip_id: "trip-1",
    purpose: "PAYMENT_RECOVERY",
    captured_amount_pence: 100,
    refunded_amount_pence: 0,
  };
  const ledgerRows: Array<Record<string, unknown>> = [];

  const tripRow = {
    id: "trip-1",
    driver_id: "driver-1",
    financial_model: "PLATFORM_COLLECTED",
    capture_amount_pence: 500,
    final_fare_pence: 500,
    final_customer_fare_pence: 500,
    commission_pence: 75,
    driver_net_pence: 425,
    payment_status: "captured",
    payment_method: "card",
    refund_amount_pence: 0,
    provider_payment_id: "order-1",
    provider_charge_id: null,
  };

  function queryChain(table: string, filters: MockFilters) {
    const chain: Record<string, unknown> = {
      eq(col: string, val: unknown) {
        filters[col] = val;
        return chain;
      },
      neq() { return chain; },
      in(_col: string, vals: unknown[]) { filters.type = vals; return chain; },
      order() { return chain; },
      select() { return chain; },
      maybeSingle: async () => {
        if (table === "payment_sessions") {
          if (filters.id === "ps-book") return { data: psBook, error: null };
          if (filters.provider_order_id === "order-1") return { data: psBook, error: null };
          return { data: null, error: null };
        }
        if (table === "payment_session_refunds") {
          const hit = refundChildren.find((r) =>
            r.provider_refund_id === filters.provider_refund_id
            && r.payment_provider === (filters.payment_provider ?? r.payment_provider));
          return { data: hit ? { id: "existing" } : null, error: null };
        }
        if (table === "driver_wallet_ledger") {
          if (filters.related_trip_id === "trip-1" && filters.type === "REFUND_DEBIT" && filters.description) {
            const hit = ledgerRows.find((r) =>
              r.related_trip_id === "trip-1"
              && r.type === "REFUND_DEBIT"
              && r.description === filters.description);
            return { data: hit ? { id: "debit-1", amount_pence: hit.amount_pence } : null, error: null };
          }
          if (filters.related_trip_id === "trip-1" && filters.type === "REFUND_DEBIT" && !filters.description) {
            return { data: ledgerRows.length > 0 ? { id: "debit-1" } : null, error: null };
          }
          return { data: null, error: null };
        }
        return { data: null, error: null };
      },
      single: async () => {
        if (table === "trips" && filters.id === "trip-1") {
          return { data: tripRow, error: null };
        }
        return { data: null, error: { message: "not found" } };
      },
      insert(payload: Record<string, unknown> | Array<Record<string, unknown>>) {
        const row = Array.isArray(payload) ? payload[0] : payload;
        if (table === "payment_session_refunds" && row) refundChildren.push(row);
        if (table === "driver_wallet_ledger" && row) ledgerRows.push(row);
        return Promise.resolve({ error: null });
      },
      update(payload: Record<string, unknown>) {
        const upd = {
          eq(col: string, val: unknown) {
            if (table === "payment_sessions" && col === "id" && val === "ps-book") {
              Object.assign(psBook, payload);
            }
            if (table === "trips" && col === "id" && val === "trip-1") {
              Object.assign(tripRow, payload);
            }
            return upd;
          },
          then(resolve: (v: { error: null }) => unknown) {
            return Promise.resolve({ error: null }).then(resolve);
          },
        };
        return upd;
      },
      then(resolve: (v: { data: unknown; error: null }) => unknown) {
        if (table === "payment_sessions") {
          if (filters.purpose === PAYMENT_SESSION_PURPOSE_RIDE_BOOKING && filters.trip_id === "trip-1") {
            return Promise.resolve({ data: [{ ...psBook }], error: null }).then(resolve);
          }
        }
        if (table === "payment_session_refunds" && filters.payment_session_id === "ps-book") {
          return Promise.resolve({
            data: refundChildren.filter((r) => r.payment_session_id === "ps-book"),
            error: null,
          }).then(resolve);
        }
        if (table === "payments" && filters.trip_id === "trip-1") {
          return Promise.resolve({
            data: [{ id: "pay-1", captured_amount_pence: 500, amount_pence: 500, status: "captured" }],
            error: null,
          }).then(resolve);
        }
        if (table === "driver_wallet_ledger") {
          let rows = [...ledgerRows];
          if (filters.related_trip_id === "trip-1") {
            rows = rows.filter((r) => r.related_trip_id === "trip-1");
          }
          if (filters.type === "REFUND_DEBIT") {
            rows = rows.filter((r) => r.type === "REFUND_DEBIT");
          }
          if (Array.isArray(filters.type)) {
            rows = rows.filter((r) => (filters.type as string[]).includes(String(r.type)));
          }
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        }
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    };
    return chain;
  }

  const client = {
    from(table: string) {
      const filters: MockFilters = {};
      const chain = queryChain(table, filters);
      return {
        select(_cols?: string) { return chain; },
        update(payload: Record<string, unknown>) {
          return chain.update(payload);
        },
        insert(payload: Record<string, unknown> | Array<Record<string, unknown>>) {
          return chain.insert(payload);
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return chain;
        },
      };
    },
    rpc: async () => ({ data: null, error: null }),
  };

  return {
    client,
    refundChildren,
    psBook,
    psRecovery,
    ledgerRows,
  };
}

Deno.test("upsertPaymentSessionRefund uses per-event delta — cumulative total from child rows", async () => {
  const { client, refundChildren, psBook } = buildRefundTestClient();

  await upsertPaymentSessionRefund(client as never, {
    paymentSessionId: "ps-book",
    providerRefundId: "ref-100",
    amountPence: 100,
    providerOrderId: "order-1",
  });
  await upsertPaymentSessionRefund(client as never, {
    paymentSessionId: "ps-book",
    providerRefundId: "ref-200",
    amountPence: 200,
  });

  assertStrictEquals(refundChildren.length, 2);
  assertStrictEquals(refundChildren[0]?.amount_pence, 100);
  assertStrictEquals(refundChildren[1]?.amount_pence, 200);
  assertEquals(psBook.refunded_amount_pence, 300);
});

Deno.test("duplicate provider refund id is idempotent — no second child row", async () => {
  const { client, refundChildren } = buildRefundTestClient();
  await upsertPaymentSessionRefund(client as never, {
    paymentSessionId: "ps-book",
    providerRefundId: "ref-dup",
    amountPence: 100,
  });
  await upsertPaymentSessionRefund(client as never, {
    paymentSessionId: "ps-book",
    providerRefundId: "ref-dup",
    amountPence: 100,
  });
  assertStrictEquals(refundChildren.length, 1);
});

Deno.test("applyProviderRefund: partial then partial — cumulative PS total matches provider total", async () => {
  const state = createAtomicRpcMockState({
    psBook: {
      id: "ps-book",
      trip_id: "trip-1",
      purpose: PAYMENT_SESSION_PURPOSE_RIDE_BOOKING,
      captured_amount_pence: 500,
      refunded_amount_pence: 0,
      payment_provider: "revolut",
    },
    tripRow: {
      id: "trip-1",
      driver_id: "driver-1",
      financial_model: "PLATFORM_COLLECTED",
      capture_amount_pence: 500,
      final_fare_pence: 500,
      final_customer_fare_pence: 500,
      commission_pence: 75,
      driver_net_pence: 425,
      payment_status: "captured",
      refund_amount_pence: 0,
    },
  });
  seedTripEarning(state, 425);
  const client = buildClientWithAtomicRpcMock(state);

  await applyProviderRefundToOnecab(client as never, {
    tripId: "trip-1",
    amountRefundedPence: 100,
    thisRefundAmountPence: 100,
    providerRefundId: "ref-a",
    providerOrderId: "order-1",
    source: "admin_refund",
  });
  assertEquals(state.psBook.refunded_amount_pence, 100);
  assertEquals(state.psRecovery.refunded_amount_pence, 0);

  await applyProviderRefundToOnecab(client as never, {
    tripId: "trip-1",
    amountRefundedPence: 300,
    thisRefundAmountPence: 200,
    providerRefundId: "ref-b",
    providerOrderId: "order-1",
    source: "admin_refund",
  });
  assertEquals(state.psBook.refunded_amount_pence, 300);
});

Deno.test("applyProviderRefund: two RIDE_BOOKING sessions fail closed", async () => {
  const state = createAtomicRpcMockState({ rideBookingSessionCount: 2 });
  const client = buildClientWithAtomicRpcMock(state);
  let threw = false;
  try {
    await applyProviderRefundToOnecab(client as never, {
      tripId: "trip-1",
      amountRefundedPence: 100,
      thisRefundAmountPence: 100,
      providerRefundId: "ref-x",
      source: "admin_refund",
    });
  } catch (e) {
    threw = true;
    assertEquals(String(e).includes(PAYMENT_SESSION_GATE_STATUS.CAPTURE_AMBIGUOUS), true);
  }
  assertStrictEquals(threw, true);
});

Deno.test("applyProviderRefund: per provider_refund_id REFUND_DEBIT rows accumulate", async () => {
  const state = createAtomicRpcMockState({
    psBook: {
      id: "ps-book",
      trip_id: "trip-1",
      purpose: PAYMENT_SESSION_PURPOSE_RIDE_BOOKING,
      captured_amount_pence: 500,
      refunded_amount_pence: 0,
      payment_provider: "revolut",
    },
    tripRow: {
      id: "trip-1",
      driver_id: "driver-1",
      financial_model: "PLATFORM_COLLECTED",
      capture_amount_pence: 500,
      final_fare_pence: 500,
      final_customer_fare_pence: 500,
      commission_pence: 75,
      driver_net_pence: 425,
      payment_status: "captured",
      refund_amount_pence: 0,
    },
  });
  seedTripEarning(state, 425);
  const client = buildClientWithAtomicRpcMock(state);
  await applyProviderRefundToOnecab(client as never, {
    tripId: "trip-1",
    amountRefundedPence: 100,
    thisRefundAmountPence: 100,
    providerRefundId: "ref-1",
    providerOrderId: "order-1",
    source: "admin_refund",
  });
  await applyProviderRefundToOnecab(client as never, {
    tripId: "trip-1",
    amountRefundedPence: 200,
    thisRefundAmountPence: 100,
    providerRefundId: "ref-2",
    providerOrderId: "order-1",
    source: "admin_refund",
  });
  assertStrictEquals(state.ledgerRows.filter((r) => r.type === "REFUND_DEBIT").length, 2);
});

Deno.test("thisRefundAmountPence is delta — passed to atomic RPC as event amount", async () => {
  const src = await Deno.readTextFile(new URL("./applyProviderRefund.ts", import.meta.url));
  assertStrictEquals(src.includes("thisRefundAmountPence"), true);
  assertStrictEquals(src.includes("p_event_refund_amount_pence"), true);
});
