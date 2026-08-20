/**
 * Step 8.2A.3 — atomic refund RPC behavioural tests (A–K harness).
 *
 * Run:
 *   deno test --allow-read --no-check supabase/functions/_shared/applyProviderRefundAtomicBehaviour.test.ts
 */
import { assert, assertEquals, assertStrictEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyProviderRefundToOnecab } from "./applyProviderRefund.ts";
import {
  buildClientWithAtomicRpcMock,
  createAtomicRpcMockState,
  seedTripEarning,
  simulateAtomicRpc,
} from "./applyProviderRefundAtomicRpcMock.ts";
import { PAYMENT_SESSION_GATE_STATUS } from "./paymentSessionCaptureGateSSOT.ts";

const CAPTURED = 1250;
const COMMISSION = 250;
const DRIVER_NET = 1000;

function baseState() {
  const state = createAtomicRpcMockState({
    psBook: {
      id: "ps-book",
      trip_id: "trip-1",
      purpose: "RIDE_BOOKING",
      captured_amount_pence: CAPTURED,
      refunded_amount_pence: 0,
      payment_provider: "revolut",
    },
    tripRow: {
      id: "trip-1",
      driver_id: "driver-1",
      financial_model: "PLATFORM_COLLECTED",
      capture_amount_pence: CAPTURED,
      final_fare_pence: CAPTURED,
      final_customer_fare_pence: CAPTURED,
      commission_pence: COMMISSION,
      driver_net_pence: DRIVER_NET,
      payment_status: "captured",
      refund_amount_pence: 0,
    },
  });
  seedTripEarning(state, DRIVER_NET);
  return state;
}

function debitSum(state: ReturnType<typeof createAtomicRpcMockState>) {
  return state.ledgerRows
    .filter((r) => r.type === "REFUND_DEBIT")
    .reduce((sum, r) => sum + Math.abs(Number(r.amount_pence ?? 0)), 0);
}

Deno.test("A: one partial refund — one child, one debit, exact cumulative", async () => {
  const state = baseState();
  const client = buildClientWithAtomicRpcMock(state);
  const result = await applyProviderRefundToOnecab(client as never, {
    tripId: "trip-1",
    amountRefundedPence: 250,
    thisRefundAmountPence: 250,
    providerRefundId: "ref-a",
    source: "admin_refund",
  });
  assertStrictEquals(state.refundChildren.length, 1);
  assertStrictEquals(state.ledgerRows.filter((r) => r.type === "REFUND_DEBIT").length, 1);
  assertStrictEquals(debitSum(state), 200);
  assertEquals(state.psBook.refunded_amount_pence, 250);
  assertEquals(result.rpc_status, "applied");
});

Deno.test("B: two sequential partial refunds — debit sum equals cumulative driver reversal", async () => {
  const state = baseState();
  const client = buildClientWithAtomicRpcMock(state);
  await applyProviderRefundToOnecab(client as never, {
    tripId: "trip-1",
    amountRefundedPence: 250,
    thisRefundAmountPence: 250,
    providerRefundId: "ref-1",
    source: "admin_refund",
  });
  await applyProviderRefundToOnecab(client as never, {
    tripId: "trip-1",
    amountRefundedPence: 625,
    thisRefundAmountPence: 375,
    providerRefundId: "ref-2",
    source: "admin_refund",
  });
  assertStrictEquals(state.refundChildren.length, 2);
  assertStrictEquals(debitSum(state), 500);
  assertEquals(state.psBook.refunded_amount_pence, 625);
});

Deno.test("C: same provider_refund_id twice — ALREADY_APPLIED, one child/debit", async () => {
  const state = baseState();
  const client = buildClientWithAtomicRpcMock(state);
  const args = {
    tripId: "trip-1",
    amountRefundedPence: 250,
    thisRefundAmountPence: 250,
    providerRefundId: "ref-dup",
    source: "admin_refund" as const,
  };
  const first = await applyProviderRefundToOnecab(client as never, args);
  const second = await applyProviderRefundToOnecab(client as never, args);
  assertStrictEquals(state.refundChildren.length, 1);
  assertStrictEquals(state.ledgerRows.filter((r) => r.type === "REFUND_DEBIT").length, 1);
  assertEquals(first.rpc_status, "applied");
  assertEquals(second.rpc_status, "already_applied");
  assertEquals(second.already_applied, true);
});

Deno.test("D: two different partial refunds serialized — no over-debit", async () => {
  const state = baseState();
  const client = buildClientWithAtomicRpcMock(state);
  await applyProviderRefundToOnecab(client as never, {
    tripId: "trip-1",
    amountRefundedPence: 250,
    thisRefundAmountPence: 250,
    providerRefundId: "ref-conc-1",
    source: "admin_refund",
  });
  await applyProviderRefundToOnecab(client as never, {
    tripId: "trip-1",
    amountRefundedPence: 625,
    thisRefundAmountPence: 375,
    providerRefundId: "ref-conc-2",
    source: "admin_refund",
  });
  assertStrictEquals(debitSum(state), 500);
  assertStrictEquals(state.refundChildren.length, 2);
});

Deno.test("E: out-of-order delivery — final child and debit sums correct", async () => {
  const state = baseState();
  const client = buildClientWithAtomicRpcMock(state);
  await applyProviderRefundToOnecab(client as never, {
    tripId: "trip-1",
    amountRefundedPence: 375,
    thisRefundAmountPence: 375,
    providerRefundId: "ref-second",
    source: "admin_refund",
  });
  await applyProviderRefundToOnecab(client as never, {
    tripId: "trip-1",
    amountRefundedPence: 625,
    thisRefundAmountPence: 250,
    providerRefundId: "ref-first",
    source: "admin_refund",
  });
  assertEquals(state.psBook.refunded_amount_pence, 625);
  assertStrictEquals(debitSum(state), 500);
});

Deno.test("F: local RPC failure then retry — zero extra provider creates, one completion", async () => {
  const state = baseState();
  state.failNextRpc = true;
  const client = buildClientWithAtomicRpcMock(state);
  await assertRejects(
    () => applyProviderRefundToOnecab(client as never, {
      tripId: "trip-1",
      amountRefundedPence: 250,
      thisRefundAmountPence: 250,
      providerRefundId: "ref-retry",
      source: "admin_refund",
    }),
    Error,
    "simulated_rpc_failure",
  );
  assertStrictEquals(state.providerRefundCreates, 0);
  const retry = await applyProviderRefundToOnecab(client as never, {
    tripId: "trip-1",
    amountRefundedPence: 250,
    thisRefundAmountPence: 250,
    providerRefundId: "ref-retry",
    source: "admin_refund",
  });
  assertEquals(retry.rpc_status, "applied");
  assertStrictEquals(state.refundChildren.length, 1);
  assertStrictEquals(debitSum(state), 200);
});

Deno.test("G: partial then full refund — final debit equals driver net, never exceeds TEN", async () => {
  const state = baseState();
  const client = buildClientWithAtomicRpcMock(state);
  await applyProviderRefundToOnecab(client as never, {
    tripId: "trip-1",
    amountRefundedPence: 250,
    thisRefundAmountPence: 250,
    providerRefundId: "ref-partial",
    source: "admin_refund",
  });
  await applyProviderRefundToOnecab(client as never, {
    tripId: "trip-1",
    amountRefundedPence: CAPTURED,
    thisRefundAmountPence: CAPTURED - 250,
    providerRefundId: "ref-full",
    source: "admin_refund",
  });
  assertStrictEquals(debitSum(state), DRIVER_NET);
  assert(debitSum(state) <= DRIVER_NET);
});

Deno.test("H: three partial refunds with rounding boundaries", async () => {
  const state = baseState();
  const client = buildClientWithAtomicRpcMock(state);
  const steps = [
    { cum: 125, delta: 125, id: "ref-h-a" },
    { cum: 250, delta: 125, id: "ref-h-b" },
    { cum: 375, delta: 125, id: "ref-h-c" },
  ];
  for (const step of steps) {
    await applyProviderRefundToOnecab(client as never, {
      tripId: "trip-1",
      amountRefundedPence: step.cum,
      thisRefundAmountPence: step.delta,
      providerRefundId: step.id,
      source: "admin_refund",
    });
  }
  assertStrictEquals(state.refundChildren.length, 3);
  assertEquals(state.psBook.refunded_amount_pence, 375);
});

Deno.test("I: PAYMENT_RECOVERY sibling untouched", async () => {
  const state = baseState();
  state.psRecovery.refunded_amount_pence = 0;
  const client = buildClientWithAtomicRpcMock(state);
  await applyProviderRefundToOnecab(client as never, {
    tripId: "trip-1",
    amountRefundedPence: 250,
    thisRefundAmountPence: 250,
    providerRefundId: "ref-i",
    source: "admin_refund",
  });
  assertEquals(state.psRecovery.refunded_amount_pence, 0);
});

Deno.test("J: two RIDE_BOOKING sessions — CAPTURE_AMBIGUOUS, no writes", async () => {
  const state = baseState();
  state.rideBookingSessionCount = 2;
  const client = buildClientWithAtomicRpcMock(state);
  await assertRejects(
    () => applyProviderRefundToOnecab(client as never, {
      tripId: "trip-1",
      amountRefundedPence: 100,
      thisRefundAmountPence: 100,
      providerRefundId: "ref-j",
      source: "admin_refund",
    }),
    Error,
    PAYMENT_SESSION_GATE_STATUS.CAPTURE_AMBIGUOUS,
  );
  assertStrictEquals(state.refundChildren.length, 0);
  assertStrictEquals(state.ledgerRows.filter((r) => r.type === "REFUND_DEBIT").length, 0);
});

Deno.test("K: historical NULL provider_refund_id debit — fail closed", async () => {
  const state = baseState();
  state.historicalNullDebit = true;
  const client = buildClientWithAtomicRpcMock(state);
  await assertRejects(
    () => applyProviderRefundToOnecab(client as never, {
      tripId: "trip-1",
      amountRefundedPence: 100,
      thisRefundAmountPence: 100,
      providerRefundId: "ref-k",
      source: "admin_refund",
    }),
    Error,
    "HISTORICAL_REFUND_DEBIT_REQUIRES_MANUAL_RECONCILIATION",
  );
});

Deno.test("simulateAtomicRpc: provider_refund_id is idempotency key not description", () => {
  const state = baseState();
  simulateAtomicRpc(state, {
    p_payment_provider: "revolut",
    p_provider_refund_id: "same-id",
    p_event_refund_amount_pence: 100,
    p_cumulative_refunded_pence: 100,
    p_source: "admin_refund",
  });
  const again = simulateAtomicRpc(state, {
    p_payment_provider: "revolut",
    p_provider_refund_id: "same-id",
    p_event_refund_amount_pence: 100,
    p_cumulative_refunded_pence: 100,
    p_source: "different-description-source",
  });
  assertEquals(again.status, "already_applied");
  assertStrictEquals(state.refundChildren.length, 1);
});
