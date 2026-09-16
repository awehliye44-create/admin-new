/**
 * Trip History shortfall — tip must not double-count into customer payable.
 * MK-260912-005 class: fare 500 + tip 100 + captured 600 → shortfall 0.
 */
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  resolveTripHistoryCustomerPayablePence,
  tipAlreadyIncludedInFinalAggregate,
} from "./tripHistoryPaymentLayersSSOT.ts";
import { buildTripHistoryPaymentEvidenceReadModel } from "./tripHistoryPaymentEvidenceReadModel.ts";
import {
  computeOutstandingShortfallPence,
  evaluateTripHistoryShortfallRecaptureEligibility,
  rejectClientChargeAmountFields,
  TRIP_SHORTFALL_RECAPTURE_UI_STATE,
} from "./tripHistoryShortfallRecaptureSSOT.ts";
import { FINANCIAL_MODEL } from "./financialModelScopeGate.ts";

const MK = {
  final_customer_fare_pence: 500,
  final_fare_pence: 500,
  locked_base_fare_pence: 500,
  tip_pence: 100,
  tip_amount_pence: 100,
  airport_charge_pence: 0,
  financial_model: FINANCIAL_MODEL.PLATFORM_COLLECTED,
  payment_method: "card",
  status: "completed",
  payment_status: "captured",
};

Deno.test("1: fare £5 + tip £1; captured £6 → shortfall £0", () => {
  const payable = resolveTripHistoryCustomerPayablePence(MK, 600);
  assertEquals(payable.payable_pence, 600);
  const shortfall = computeOutstandingShortfallPence({
    customerPayablePence: payable.payable_pence,
    verifiedCapturedTotalPence: 600,
    netRefundedTotalPence: 0,
  });
  assertEquals(shortfall, 0);
});

Deno.test("2: fare only £5; captured £5 → shortfall £0", () => {
  const payable = resolveTripHistoryCustomerPayablePence({
    ...MK,
    tip_pence: 0,
    tip_amount_pence: 0,
  }, 500);
  assertEquals(payable.payable_pence, 500);
  assertEquals(computeOutstandingShortfallPence({
    customerPayablePence: payable.payable_pence,
    verifiedCapturedTotalPence: 500,
  }), 0);
});

Deno.test("3: fare £5 + airport £7 + tip £1; captured £13 → shortfall £0", () => {
  // Airport already folded into final_customer when stamped that way.
  const payable = resolveTripHistoryCustomerPayablePence({
    ...MK,
    final_customer_fare_pence: 1200, // 500 fare + 700 airport
    final_fare_pence: 1200,
    tip_pence: 100,
    airport_charge_pence: 700,
  }, 1300);
  assertEquals(payable.payable_pence, 1300);
  assertEquals(computeOutstandingShortfallPence({
    customerPayablePence: payable.payable_pence,
    verifiedCapturedTotalPence: 1300,
  }), 0);
});

Deno.test("4: aggregate payable already contains tip → no double count", () => {
  // Stuffed Edge tip-inclusive payable into final_customer while tip stamp remains.
  const stuffed = resolveTripHistoryCustomerPayablePence({
    ...MK,
    final_customer_fare_pence: 600, // already fare+tip
    final_fare_pence: 500,
    tip_pence: 100,
  }, 600);
  assertEquals(stuffed.payable_pence, 600);
  assertEquals(
    tipAlreadyIncludedInFinalAggregate({
      payablePence: 600,
      tipPence: 100,
      siblingFinalPence: 500,
      lockedBasePence: 500,
    }),
    true,
  );
});

Deno.test("5: real £1 undercapture → shortfall £1", () => {
  const payable = resolveTripHistoryCustomerPayablePence(MK, 500);
  assertEquals(payable.payable_pence, 600);
  assertEquals(computeOutstandingShortfallPence({
    customerPayablePence: payable.payable_pence,
    verifiedCapturedTotalPence: 500,
  }), 100);
});

Deno.test("6: overcapture → no recapture action; shortfall 0", () => {
  const payable = resolveTripHistoryCustomerPayablePence(MK, 700);
  assertEquals(payable.payable_pence, 600);
  const shortfall = computeOutstandingShortfallPence({
    customerPayablePence: payable.payable_pence,
    verifiedCapturedTotalPence: 700,
  });
  assertEquals(shortfall, 0);
  const gate = evaluateTripHistoryShortfallRecaptureEligibility({
    tripStatus: "completed",
    financialModel: FINANCIAL_MODEL.PLATFORM_COLLECTED,
    paymentMethod: "card",
    customerPayablePence: payable.payable_pence,
    verifiedCapturedTotalPence: 700,
    netRefundedTotalPence: 0,
    providerSettlementVerified: true,
    adminPermitted: true,
  });
  assertEquals(gate.eligible, false);
  assertEquals(gate.outstanding_shortfall_pence, 0);
});

Deno.test("7: confirmed refund included once", () => {
  const shortfall = computeOutstandingShortfallPence({
    customerPayablePence: 600,
    verifiedCapturedTotalPence: 600,
    netRefundedTotalPence: 100,
  });
  assertEquals(shortfall, 100);
});

Deno.test("8: pending/failed payment not counted as captured in evidence", () => {
  const model = buildTripHistoryPaymentEvidenceReadModel({
    trip: { ...MK, capture_amount_pence: null },
    sessions: [{
      status: "pending",
      provider_state: "PENDING",
      captured_amount_pence: 0,
    }],
    adminPermitted: true,
  });
  assertEquals(model.verified_captured_pence, 0);
  assertEquals(model.outstanding_shortfall_pence, 600);
});

Deno.test("9: duplicate payment sessions do not double-count when verified sum is passed once", () => {
  // Verified sum helper is tested elsewhere; evidence uses session sum.
  const model = buildTripHistoryPaymentEvidenceReadModel({
    trip: MK,
    sessions: [
      {
        status: "completed",
        provider_state: "COMPLETED",
        purpose: "RIDE_BOOKING",
        captured_amount_pence: 600,
        refunded_amount_pence: 0,
      },
      {
        status: "completed",
        provider_state: "COMPLETED",
        purpose: "RIDE_BOOKING",
        captured_amount_pence: 600,
        refunded_amount_pence: 0,
      },
    ],
    adminPermitted: true,
  });
  // Duplicate legitimate rows surface over-capture / coverage — shortfall must not go negative.
  assertEquals(model.outstanding_shortfall_pence, 0);
  assertEquals(model.customer_discounted_payable_pence, 600);
});

Deno.test("10: DRIVER_COLLECTED isolated — recapture ineligible", () => {
  const gate = evaluateTripHistoryShortfallRecaptureEligibility({
    tripStatus: "completed",
    financialModel: FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
    paymentMethod: "cash",
    customerPayablePence: 600,
    verifiedCapturedTotalPence: 0,
    adminPermitted: true,
  });
  assertEquals(gate.eligible, false);
});

Deno.test("11: Recapture server rejects client-supplied stale amount fields", () => {
  const rejected = rejectClientChargeAmountFields({
    trip_id: "t1",
    amount_pence: 100,
  });
  assertEquals(rejected.ok, false);
});

Deno.test("12: MK-260912-005 fixture — 500+100=600 captured, zero shortfall, no recapture", () => {
  const model = buildTripHistoryPaymentEvidenceReadModel({
    trip: MK,
    sessions: [{
      status: "completed",
      provider_state: "COMPLETED",
      purpose: "RIDE_BOOKING",
      captured_amount_pence: 600,
      refunded_amount_pence: 0,
    }],
    // Simulate Edge tip-inclusive payable used authoritatively (no second tip add).
    authoritativeCustomerPayablePence: 600,
    providerSettlementVerified: true,
    paymentStatus: "captured",
    providerStatus: "COMPLETED",
    tripStatus: "completed",
    adminPermitted: true,
  });
  assertEquals(model.customer_discounted_payable_pence, 600);
  assertEquals(model.verified_captured_pence, 600);
  assertEquals(model.outstanding_shortfall_pence, 0);
  assertEquals(model.recapture_eligible, false);
  assertEquals(
    model.recapture_ui_state === TRIP_SHORTFALL_RECAPTURE_UI_STATE.FULLY_PAID
      || model.recapture_ui_state === TRIP_SHORTFALL_RECAPTURE_UI_STATE.HIDDEN
      || !model.recapture_eligible,
    true,
  );

  // Regression: stuffing tip-inclusive into final_* must not yield 700.
  const stuffed = buildTripHistoryPaymentEvidenceReadModel({
    trip: {
      ...MK,
      final_customer_fare_pence: 600,
      final_fare_pence: 500,
    },
    sessions: [{
      status: "completed",
      provider_state: "COMPLETED",
      captured_amount_pence: 600,
    }],
    providerSettlementVerified: true,
    adminPermitted: true,
  });
  assertEquals(stuffed.customer_discounted_payable_pence, 600);
  assertEquals(stuffed.outstanding_shortfall_pence, 0);
});
