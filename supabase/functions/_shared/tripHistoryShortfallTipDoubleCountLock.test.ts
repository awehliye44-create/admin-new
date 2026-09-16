/**
 * Customer shortfall evidence — tip/airport never double-counted.
 * Provider-call boundary stays closed for every ineligible case.
 */
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  buildCustomerShortfallEvidence,
  CUSTOMER_PAYABLE_SOURCE,
  evaluateRecaptureProviderCallBoundary,
  FARE_FIELD_CONTRACT,
  resolveAuthoritativeCustomerPayable,
} from "./customerShortfallEvidenceSSOT.ts";
import { buildTripHistoryPaymentEvidenceReadModel } from "./tripHistoryPaymentEvidenceReadModel.ts";
import { rejectClientChargeAmountFields } from "./tripHistoryShortfallRecaptureSSOT.ts";
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

const verifiedSession = {
  status: "completed",
  provider_state: "COMPLETED",
  purpose: "RIDE_BOOKING",
  captured_amount_pence: 600,
  refunded_amount_pence: 0,
};

Deno.test("1+2: fare 500 + tip 100; aggregate 600; captured 600 → shortfall 0; tip once", () => {
  const fromComponents = resolveAuthoritativeCustomerPayable({
    ...MK,
    fare_field_contract: FARE_FIELD_CONTRACT.TIP_EXCLUSIVE_FINAL,
  });
  assertEquals(fromComponents.payable_pence, 600);
  assertEquals(fromComponents.source, CUSTOMER_PAYABLE_SOURCE.COMPONENTS_TIP_EXCLUSIVE_FINAL);

  const fromAuth = resolveAuthoritativeCustomerPayable({
    customer_payable_pence: 600,
    tip_pence: 100,
    final_customer_fare_pence: 500,
  });
  assertEquals(fromAuth.payable_pence, 600); // tip NOT added again

  const ev = buildCustomerShortfallEvidence({
    ...MK,
    customer_payable_pence: 600,
    sessions: [verifiedSession],
    adminPermitted: true,
  });
  assertEquals(ev.authoritative_customer_payable_pence, 600);
  assertEquals(ev.verified_captured_pence, 600);
  assertEquals(ev.outstanding_shortfall_pence, 0);
  assertEquals(ev.allow_provider_call, false);
  assertEquals(evaluateRecaptureProviderCallBoundary(ev).allow_provider_call, false);
});

Deno.test("3: fare only 500; captured 500 → 0", () => {
  const ev = buildCustomerShortfallEvidence({
    ...MK,
    tip_pence: 0,
    tip_amount_pence: 0,
    sessions: [{ ...verifiedSession, captured_amount_pence: 500 }],
    fare_field_contract: FARE_FIELD_CONTRACT.TIP_EXCLUSIVE_FINAL,
    adminPermitted: true,
  });
  assertEquals(ev.authoritative_customer_payable_pence, 500);
  assertEquals(ev.outstanding_shortfall_pence, 0);
  assertEquals(ev.allow_provider_call, false);
});

Deno.test("4+5: fare 500 + airport 700 folded + tip 100; payable 1300; captured 1300 → 0", () => {
  const ev = buildCustomerShortfallEvidence({
    ...MK,
    final_customer_fare_pence: 1200, // airport folded into tip-exclusive final
    final_fare_pence: 1200,
    airport_charge_pence: 700, // display only — not added again
    tip_pence: 100,
    sessions: [{ ...verifiedSession, captured_amount_pence: 1300 }],
    fare_field_contract: FARE_FIELD_CONTRACT.TIP_EXCLUSIVE_FINAL,
    adminPermitted: true,
  });
  assertEquals(ev.authoritative_customer_payable_pence, 1300);
  assertEquals(ev.airport_component_pence, 700);
  assertEquals(ev.outstanding_shortfall_pence, 0);
  assertEquals(ev.allow_provider_call, false);
});

Deno.test("6: real shortfall payable 700 captured 600 → 100; provider allowed", () => {
  const ev = buildCustomerShortfallEvidence({
    final_customer_fare_pence: 600,
    final_fare_pence: 600,
    tip_pence: 100,
    financial_model: FINANCIAL_MODEL.PLATFORM_COLLECTED,
    payment_method: "card",
    status: "completed",
    payment_status: "captured",
    sessions: [{ ...verifiedSession, captured_amount_pence: 600 }],
    fare_field_contract: FARE_FIELD_CONTRACT.TIP_EXCLUSIVE_FINAL,
    adminPermitted: true,
    providerSettlementVerified: true,
  });
  assertEquals(ev.authoritative_customer_payable_pence, 700);
  assertEquals(ev.outstanding_shortfall_pence, 100);
  assertEquals(ev.allow_provider_call, true);
});

Deno.test("7: confirmed refund opens shortfall", () => {
  const ev = buildCustomerShortfallEvidence({
    ...MK,
    customer_payable_pence: 700,
    sessions: [{
      ...verifiedSession,
      captured_amount_pence: 700,
      refunded_amount_pence: 100,
    }],
    adminPermitted: true,
    providerSettlementVerified: true,
  });
  assertEquals(ev.verified_net_captured_pence, 600);
  assertEquals(ev.outstanding_shortfall_pence, 100);
});

Deno.test("8: pending refund not confirmed — refunded stays 0 from unverified", () => {
  const ev = buildCustomerShortfallEvidence({
    ...MK,
    customer_payable_pence: 600,
    sessions: [{
      status: "pending_refund",
      provider_state: "PENDING",
      captured_amount_pence: 600,
      refunded_amount_pence: 100,
    }],
    adminPermitted: true,
  });
  // Unverified session: capture/refund not counted as verified settled
  assertEquals(ev.verified_captured_pence, 0);
});

Deno.test("9+10: pending/failed/declined not captured", () => {
  for (const s of [
    { status: "pending", provider_state: "PENDING", captured_amount_pence: 600 },
    { status: "failed", provider_state: "FAILED", captured_amount_pence: 600 },
    { status: "declined", provider_state: "DECLINED", captured_amount_pence: 600 },
    { status: "cancelled", provider_state: "CANCELLED", captured_amount_pence: 600 },
  ]) {
    const ev = buildCustomerShortfallEvidence({
      ...MK,
      customer_payable_pence: 600,
      sessions: [s],
      adminPermitted: true,
    });
    assertEquals(ev.verified_captured_pence, 0);
  }
});

Deno.test("11: duplicate sessions — shortfall never negative", () => {
  const ev = buildCustomerShortfallEvidence({
    ...MK,
    customer_payable_pence: 600,
    sessions: [verifiedSession, { ...verifiedSession }],
    adminPermitted: true,
  });
  assertEquals(ev.outstanding_shortfall_pence, 0);
  assertEquals(ev.allow_provider_call, false);
});

Deno.test("12: overcapture → no recapture", () => {
  const ev = buildCustomerShortfallEvidence({
    ...MK,
    customer_payable_pence: 600,
    sessions: [{ ...verifiedSession, captured_amount_pence: 800 }],
    adminPermitted: true,
  });
  assertEquals(ev.outstanding_shortfall_pence, 0);
  assertEquals(ev.recapture_eligible, false);
  assertEquals(ev.allow_provider_call, false);
});

Deno.test("13+14: missing / unknown semantics → unavailable, no button", () => {
  const missing = buildCustomerShortfallEvidence({
    fare_field_contract: FARE_FIELD_CONTRACT.UNKNOWN,
    tip_pence: 100,
    final_customer_fare_pence: 600,
    sessions: [verifiedSession],
    adminPermitted: true,
  });
  assertEquals(missing.authoritative_customer_payable_pence, null);
  assertEquals(missing.outstanding_shortfall_pence, null);
  assertEquals(missing.recapture_eligible, false);
  assertEquals(missing.allow_provider_call, false);
  assertEquals(missing.reject_code, "PAYABLE_UNAVAILABLE");
});

Deno.test("15: stale client amount rejected before provider boundary", () => {
  const ev = buildCustomerShortfallEvidence({
    ...MK,
    customer_payable_pence: 700,
    sessions: [{ ...verifiedSession, captured_amount_pence: 600 }],
    client_expected_shortfall_pence: 50, // stale vs server 100
    adminPermitted: true,
    providerSettlementVerified: true,
  });
  assertEquals(ev.outstanding_shortfall_pence, 100);
  assertEquals(ev.allow_provider_call, false);
  assertEquals(ev.reject_code, "STALE_CLIENT_AMOUNT");
  assertEquals(evaluateRecaptureProviderCallBoundary(ev).allow_provider_call, false);
});

Deno.test("16: client amount fields rejected by request gate", () => {
  const rejected = rejectClientChargeAmountFields({ trip_id: "t1", amount_pence: 100 });
  assertEquals(rejected.ok, false);
});

Deno.test("17: ownership mismatch rejected", () => {
  const ev = buildCustomerShortfallEvidence({
    ...MK,
    customer_payable_pence: 700,
    passenger_id: "passenger-a",
    sessions: [{
      ...verifiedSession,
      captured_amount_pence: 600,
      customer_id: "passenger-b",
    }],
    adminPermitted: true,
    providerSettlementVerified: true,
  });
  assertEquals(ev.reject_code, "SESSION_CUSTOMER_MISMATCH");
  assertEquals(ev.allow_provider_call, false);
});

Deno.test("18+19: PLATFORM only; DRIVER_COLLECTED blocked", () => {
  const dc = buildCustomerShortfallEvidence({
    ...MK,
    customer_payable_pence: 700,
    financial_model: FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
    sessions: [{ ...verifiedSession, captured_amount_pence: 600 }],
    adminPermitted: true,
  });
  assertEquals(dc.allow_provider_call, false);
  assertEquals(dc.reject_code, "DRIVER_COLLECTED_NOT_ALLOWED");
});

Deno.test("20: MK-260912-005 fixture 600/600/0", () => {
  const model = buildTripHistoryPaymentEvidenceReadModel({
    trip: MK,
    sessions: [verifiedSession],
    customer_payable_pence: 600,
    providerSettlementVerified: true,
    adminPermitted: true,
    tripStatus: "completed",
  });
  assertEquals(model.customer_discounted_payable_pence, 600);
  assertEquals(model.verified_captured_pence, 600);
  assertEquals(model.outstanding_shortfall_pence, 0);
  assertEquals(model.recapture_eligible, false);
});

Deno.test("21: genuine shortfall remains actionable", () => {
  const model = buildTripHistoryPaymentEvidenceReadModel({
    trip: {
      ...MK,
      final_customer_fare_pence: 600,
      final_fare_pence: 600,
      tip_pence: 100,
    },
    sessions: [{ ...verifiedSession, captured_amount_pence: 600 }],
    providerSettlementVerified: true,
    adminPermitted: true,
    tripStatus: "completed",
  });
  assertEquals(model.customer_discounted_payable_pence, 700);
  assertEquals(model.outstanding_shortfall_pence, 100);
  assertEquals(model.recapture_eligible, true);
});

Deno.test("22: provider mock invocation count is zero for all ineligible cases", () => {
  let providerCalls = 0;
  const maybeCallProvider = (allow: boolean) => {
    if (allow) providerCalls += 1;
  };

  const cases = [
    buildCustomerShortfallEvidence({
      ...MK,
      customer_payable_pence: 600,
      sessions: [verifiedSession],
      adminPermitted: true,
    }),
    buildCustomerShortfallEvidence({
      fare_field_contract: FARE_FIELD_CONTRACT.UNKNOWN,
      final_customer_fare_pence: 600,
      tip_pence: 100,
      sessions: [verifiedSession],
      adminPermitted: true,
    }),
    buildCustomerShortfallEvidence({
      ...MK,
      customer_payable_pence: 700,
      sessions: [{ ...verifiedSession, captured_amount_pence: 600 }],
      client_expected_shortfall_pence: 1,
      adminPermitted: true,
      providerSettlementVerified: true,
    }),
    buildCustomerShortfallEvidence({
      ...MK,
      financial_model: FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
      customer_payable_pence: 700,
      sessions: [{ ...verifiedSession, captured_amount_pence: 600 }],
      adminPermitted: true,
    }),
  ];

  for (const ev of cases) {
    const b = evaluateRecaptureProviderCallBoundary(ev);
    assertEquals(b.allow_provider_call, false);
    maybeCallProvider(b.allow_provider_call);
  }
  assertEquals(providerCalls, 0);
});

Deno.test("admin-get-trip-payment-state never stuffs tip-inclusive into final_customer_fare", async () => {
  const root = new URL("../../../", import.meta.url);
  const src = await Deno.readTextFile(
    new URL("supabase/functions/admin-get-trip-payment-state/index.ts", root),
  );
  assertEquals(
    /final_customer_fare_pence:\s*customer_payable_pence\s*>\s*0/.test(src),
    false,
  );
  assertEquals(src.includes("customer_payable_pence,"), true);
  assertEquals(src.includes("Tip-exclusive trip stamp only"), true);
});
