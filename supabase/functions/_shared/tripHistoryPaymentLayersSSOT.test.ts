import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  resolveTripHistoryCustomerPayablePence,
  resolveTripHistoryPaymentLayers,
  sumDisplayCapturedFromSessions,
} from "./tripHistoryPaymentLayersSSOT.ts";

Deno.test("layers: Payment Sessions capture wins for completed Revolut trip", () => {
  const layers = resolveTripHistoryPaymentLayers({
    sessions: [{
      purpose: "RIDE_BOOKING",
      status: "completed",
      provider_state: "COMPLETED",
      captured_amount_pence: 595,
      authorised_amount_pence: 595,
      refunded_amount_pence: 0,
    }],
    trip: {
      final_fare_pence: 619,
      final_customer_fare_pence: 595,
      authorised_amount_pence: 595,
      capture_amount_pence: null,
    },
  });
  assertEquals(layers.captured_pence, 595);
  assertEquals(layers.authorized_pence, 595);
  assertEquals(layers.refunded_pence, 0);
  assertEquals(layers.refundable_pence, 595);
  assertEquals(layers.evidence_source, "payment_sessions");
  assertEquals(layers.has_payment_evidence, true);
});

Deno.test("layers: positive capture with odd status still surfaces (unify empty trips)", () => {
  assertEquals(
    sumDisplayCapturedFromSessions([{
      status: "AUTHORISED",
      provider_state: null,
      captured_amount_pence: 400,
    }]),
    400,
  );
  const layers = resolveTripHistoryPaymentLayers({
    sessions: [{
      status: "AUTHORISED",
      captured_amount_pence: 400,
      authorised_amount_pence: 800,
    }],
    trip: { final_fare_pence: 400 },
  });
  assertEquals(layers.captured_pence, 400);
  assertEquals(layers.authorized_pence, 800);
  assertEquals(layers.evidence_source, "payment_sessions");
});

Deno.test("layers: fall back to trip.capture_amount_pence when sessions empty", () => {
  const layers = resolveTripHistoryPaymentLayers({
    sessions: [],
    trip: {
      capture_amount_pence: 512,
      authorised_amount_pence: 700,
      final_fare_pence: 512,
    },
  });
  assertEquals(layers.captured_pence, 512);
  assertEquals(layers.authorized_pence, 700);
  assertEquals(layers.evidence_source, "trip_capture");
});

Deno.test("layers: fall back to legacy payments when no PS / trip capture", () => {
  const layers = resolveTripHistoryPaymentLayers({
    sessions: [],
    trip: { final_fare_pence: 300 },
    payments: [{ captured_amount_pence: 300, status: "captured" }],
  });
  assertEquals(layers.captured_pence, 300);
  assertEquals(layers.evidence_source, "legacy_payments");
});

Deno.test("layers: no-show fee is customer payable and pairs with capture", () => {
  const payable = resolveTripHistoryCustomerPayablePence({
    no_show_charge_pence: 500,
    final_fare_pence: null,
    final_customer_fare_pence: null,
  });
  assertEquals(payable.payable_pence, 500);
  assertEquals(payable.source, "no_show_charge_pence");

  const layers = resolveTripHistoryPaymentLayers({
    sessions: [{
      status: "captured",
      provider_state: "COMPLETED",
      captured_amount_pence: 500,
      authorised_amount_pence: 1200,
    }],
    trip: {
      no_show_charge_pence: 500,
      capture_amount_pence: 500,
    },
  });
  assertEquals(layers.customer_payable_pence, 500);
  assertEquals(layers.captured_pence, 500);
  assertEquals(layers.refundable_pence, 500);
  assertEquals(layers.has_payment_evidence, true);
});

Deno.test("layers: cancellation / arrival fee payable when no final fare", () => {
  const cancel = resolveTripHistoryCustomerPayablePence({
    cancellation_fee_pence: 350,
  });
  assertEquals(cancel.payable_pence, 350);

  const arrival = resolveTripHistoryCustomerPayablePence({
    arrival_cancellation_applied: true,
    arrival_cancellation_fee: 4.0, // pounds
  });
  assertEquals(arrival.payable_pence, 400);
});

Deno.test("layers: never invent capture from fare alone", () => {
  const layers = resolveTripHistoryPaymentLayers({
    sessions: [],
    trip: {
      final_fare_pence: 900,
      final_customer_fare_pence: 900,
      authorised_amount_pence: 0,
      capture_amount_pence: null,
    },
    payments: [],
  });
  assertEquals(layers.captured_pence, 0);
  assertEquals(layers.customer_payable_pence, 900);
  assertEquals(layers.evidence_source, "none");
  // Payable alone counts as evidence for coverage (not fabricated capture).
  assertEquals(layers.has_payment_evidence, true);
});
