import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildSessionCaptureByTripId,
  buildWalletEarningInputsFromPaymentSessions,
} from "./driverWalletCaptureConsumeSSOT.ts";
import { sumClearedSettlementBatchPence } from "./payoutEligibilitySSOT.ts";

Deno.test("wallet consume: PS capture 480 wins; trips.capture never consulted", () => {
  const sessionCaptureByTripId = buildSessionCaptureByTripId([
    { trip_id: "ff155f09", captured_amount_pence: 480 },
  ]);
  const inputs = buildWalletEarningInputsFromPaymentSessions({
    settlements: [{
      trip_id: "ff155f09",
      settlement_status: "settled",
      ledger_amount_pence: 408,
      allocated_to_payout: false,
      allocated_amount_pence: 0,
    }],
    sessionCaptureByTripId,
    tripMetaById: new Map([
      ["ff155f09", {
        payment_method: "card",
        final_customer_fare_pence: 480,
      }],
    ]),
  });
  assertEquals(inputs[0].payment_captured, true);
  assertEquals(inputs[0].captured_amount_pence, 480);
  assertEquals(inputs[0].capture_mismatch_unresolved, false);
  assertEquals(sumClearedSettlementBatchPence(inputs), 408);
});

Deno.test("wallet consume: never invent capture from trip when PS missing", () => {
  const inputs = buildWalletEarningInputsFromPaymentSessions({
    settlements: [{
      trip_id: "t-invent",
      settlement_status: "settled",
      ledger_amount_pence: 500,
      allocated_to_payout: false,
      allocated_amount_pence: 0,
    }],
    sessionCaptureByTripId: new Map(),
    tripMetaById: new Map([
      ["t-invent", {
        payment_method: "card",
        // Trip History may still show a fare — must not become customer capture.
        final_customer_fare_pence: 780,
      }],
    ]),
  });
  assertEquals(inputs[0].payment_captured, false);
  assertEquals(inputs[0].captured_amount_pence, null);
  assertEquals(inputs[0].capture_mismatch_unresolved, true);
  assertEquals(sumClearedSettlementBatchPence(inputs), 0);
});

Deno.test("wallet consume: zero PS capture is not confirmed", () => {
  const sessionCaptureByTripId = buildSessionCaptureByTripId([
    { trip_id: "t-zero", captured_amount_pence: 0 },
  ]);
  assertEquals(sessionCaptureByTripId.has("t-zero"), false);
  const inputs = buildWalletEarningInputsFromPaymentSessions({
    settlements: [{
      trip_id: "t-zero",
      settlement_status: "settled",
      ledger_amount_pence: 100,
      allocated_to_payout: false,
    }],
    sessionCaptureByTripId,
    tripMetaById: new Map([["t-zero", { payment_method: "apple_pay", final_customer_fare_pence: 100 }]]),
  });
  assertEquals(inputs[0].payment_captured, false);
  assertEquals(sumClearedSettlementBatchPence(inputs), 0);
});

Deno.test("wallet consume: cash does not require Payment Session capture", () => {
  const inputs = buildWalletEarningInputsFromPaymentSessions({
    settlements: [{
      trip_id: "t-cash",
      settlement_status: "pending",
      ledger_amount_pence: 687,
      allocated_to_payout: false,
    }],
    sessionCaptureByTripId: new Map(),
    tripMetaById: new Map([["t-cash", { payment_method: "cash", final_customer_fare_pence: 793 }]]),
  });
  assertEquals(inputs[0].payment_captured, true);
  assertEquals(inputs[0].captured_amount_pence, null);
  assertEquals(inputs[0].capture_mismatch_unresolved, false);
  assertEquals(sumClearedSettlementBatchPence(inputs), 687);
});

Deno.test("sumClearedSettlementBatchPence card requires confirmed capture amount", () => {
  assertEquals(
    sumClearedSettlementBatchPence([{
      amount_pence: 408,
      payment_method: "card",
      settlement_status: "settled",
      payment_captured: true,
      captured_amount_pence: null,
      capture_mismatch_unresolved: false,
    }]),
    0,
  );
  assertEquals(
    sumClearedSettlementBatchPence([{
      amount_pence: 408,
      payment_method: "card",
      settlement_status: "settled",
      payment_captured: true,
      captured_amount_pence: 480,
      capture_mismatch_unresolved: false,
    }]),
    408,
  );
});
