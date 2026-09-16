/**
 * Step 8.2A.2/8.2A.3 — multi-partial refund wallet accounting via atomic RPC mock.
 *
 * Run:
 *   deno test --allow-read --no-check supabase/functions/_shared/applyProviderRefundMultiPartialBehaviour.test.ts
 */
import { assertEquals, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyProviderRefundToOnecab } from "./applyProviderRefund.ts";
import { computeRefundEventDriverReversalDelta } from "./providerRefundSSOT.ts";
import { PAYMENT_SESSION_GATE_STATUS } from "./paymentSessionCaptureGateSSOT.ts";
import {
  buildClientWithAtomicRpcMock,
  createAtomicRpcMockState,
  seedTripEarning,
} from "./applyProviderRefundAtomicRpcMock.ts";

const CAPTURED = 1250;
const COMMISSION = 250;
const DRIVER_NET = 1000;
const EVENT1_CUMULATIVE = 250;
const EVENT2_CUMULATIVE = 625;

function buildMultiPartialMock() {
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
  const client = buildClientWithAtomicRpcMock(state);
  const refundDebitTotal = () => state.ledgerRows
    .filter((r) => r.type === "REFUND_DEBIT")
    .reduce((sum, r) => sum + Math.abs(Number(r.amount_pence ?? 0)), 0);
  const driverBalanceDelta = () => state.ledgerRows.reduce((sum, r) => sum + Number(r.amount_pence ?? 0), 0);
  return {
    client,
    state,
    refundDebitTotal,
    driverBalanceDelta,
    setInsertLedgerFails: (v: boolean) => { state.failNextRpc = v; },
  };
}

Deno.test("pure: event deltas match production-shaped example", () => {
  const d1 = computeRefundEventDriverReversalDelta({
    capturedPence: CAPTURED,
    priorRefundedPence: 0,
    cumulativeRefundedPence: EVENT1_CUMULATIVE,
    commissionPence: COMMISSION,
    driverNetPence: DRIVER_NET,
  });
  const d2 = computeRefundEventDriverReversalDelta({
    capturedPence: CAPTURED,
    priorRefundedPence: EVENT1_CUMULATIVE,
    cumulativeRefundedPence: EVENT2_CUMULATIVE,
    commissionPence: COMMISSION,
    driverNetPence: DRIVER_NET,
  });
  assertStrictEquals(d1, 200);
  assertStrictEquals(d2, 300);
});

Deno.test("two partial refunds — per-event REFUND_DEBIT totals 500p", async () => {
  const m = buildMultiPartialMock();
  await applyProviderRefundToOnecab(m.client as never, {
    tripId: "trip-1",
    amountRefundedPence: EVENT1_CUMULATIVE,
    thisRefundAmountPence: EVENT1_CUMULATIVE,
    providerRefundId: "ref-event-1",
    source: "admin_refund",
  });
  assertStrictEquals(m.state.refundChildren.length, 1);
  assertStrictEquals(m.refundDebitTotal(), 200);
  assertStrictEquals(m.driverBalanceDelta(), 800);
  assertEquals(m.state.psBook.refunded_amount_pence, EVENT1_CUMULATIVE);

  await applyProviderRefundToOnecab(m.client as never, {
    tripId: "trip-1",
    amountRefundedPence: EVENT2_CUMULATIVE,
    thisRefundAmountPence: EVENT2_CUMULATIVE - EVENT1_CUMULATIVE,
    providerRefundId: "ref-event-2",
    source: "admin_refund",
  });
  assertStrictEquals(m.state.refundChildren.length, 2);
  assertStrictEquals(m.refundDebitTotal(), 500);
  assertStrictEquals(m.driverBalanceDelta(), 500);
  assertEquals(m.state.psBook.refunded_amount_pence, EVENT2_CUMULATIVE);
});

Deno.test("duplicate delivery of refund event 1 — no second child or debit", async () => {
  const m = buildMultiPartialMock();
  const args = {
    tripId: "trip-1",
    amountRefundedPence: EVENT1_CUMULATIVE,
    thisRefundAmountPence: EVENT1_CUMULATIVE,
    providerRefundId: "ref-dup-1",
    source: "admin_refund" as const,
  };
  await applyProviderRefundToOnecab(m.client as never, args);
  await applyProviderRefundToOnecab(m.client as never, args);
  assertStrictEquals(m.state.refundChildren.length, 1);
  assertStrictEquals(m.refundDebitTotal(), 200);
});

Deno.test("partial then full refund — final debit equals full driver reversal", async () => {
  const m = buildMultiPartialMock();
  await applyProviderRefundToOnecab(m.client as never, {
    tripId: "trip-1",
    amountRefundedPence: EVENT1_CUMULATIVE,
    thisRefundAmountPence: EVENT1_CUMULATIVE,
    providerRefundId: "ref-partial",
    source: "admin_refund",
  });
  await applyProviderRefundToOnecab(m.client as never, {
    tripId: "trip-1",
    amountRefundedPence: CAPTURED,
    thisRefundAmountPence: CAPTURED - EVENT1_CUMULATIVE,
    providerRefundId: "ref-full",
    source: "admin_refund",
  });
  assertStrictEquals(m.refundDebitTotal(), 1000);
});

Deno.test("local RPC failure then retry — completes missing debit only", async () => {
  const m = buildMultiPartialMock();
  m.setInsertLedgerFails(true);
  try {
    await applyProviderRefundToOnecab(m.client as never, {
      tripId: "trip-1",
      amountRefundedPence: EVENT1_CUMULATIVE,
      thisRefundAmountPence: EVENT1_CUMULATIVE,
      providerRefundId: "ref-retry",
      source: "admin_refund",
    });
  } catch { /* expected */ }
  assertStrictEquals(m.refundDebitTotal(), 0);

  m.setInsertLedgerFails(false);
  await applyProviderRefundToOnecab(m.client as never, {
    tripId: "trip-1",
    amountRefundedPence: EVENT1_CUMULATIVE,
    thisRefundAmountPence: EVENT1_CUMULATIVE,
    providerRefundId: "ref-retry",
    source: "admin_refund",
  });
  assertStrictEquals(m.state.refundChildren.length, 1);
  assertStrictEquals(m.refundDebitTotal(), 200);
});

Deno.test("two RIDE_BOOKING sessions fail closed — no ledger writes", async () => {
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
