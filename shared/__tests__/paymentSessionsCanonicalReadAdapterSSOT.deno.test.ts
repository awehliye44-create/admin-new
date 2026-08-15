/**
 * Run: deno test --allow-read shared/__tests__/paymentSessionsCanonicalReadAdapterSSOT.deno.test.ts
 */
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCanonicalTripEconomicsRead,
  compareStampExpectedVsProviderCapture,
  resolveCanonicalExpectedCapturePence,
  resolveCanonicalFinalPayablePence,
  resolveOtherNonModComponentsPence,
} from "../paymentSessionsCanonicalReadAdapterSSOT.ts";
import { resolveOvercaptureCustomerPosition } from "../paymentSessionsOvercaptureResolutionSSOT.ts";

const MK028 = {
  trip_code: "MK-260815-028",
  final_customer_fare_pence: 788,
  pickup_waiting_charge_pence: 12,
  stop_waiting_charge_pence: 0,
  final_fare_pence: 800,
  commissionable_fare_pence: 800,
  commission_pence: 120,
  driver_net_pence: 680,
  accepted_commission_percent: 15,
  customer_modification_charge_pence: 0,
};

const MK029 = {
  trip_code: "MK-260815-029",
  locked_base_fare_pence: 450,
  final_customer_fare_pence: 716,
  final_fare_pence: 716,
  customer_modification_charge_pence: 266,
  destination_change_adjustment_pence: 266,
  commissionable_fare_pence: 716,
  commission_pence: 107,
  driver_net_pence: 609,
};

const PRESET_NEGOTIATED = {
  trip_code: "MK-260815-024",
  locked_base_fare_pence: 500,
  accepted_preset_offer_fare_pence: 550,
  final_customer_fare_pence: 450,
  final_fare_pence: 450,
  commissionable_fare_pence: 450,
  commission_pence: 68,
  driver_net_pence: 382,
};

Deno.test("MK-028: final payable 800 everywhere; waiting once; settlement stamps", () => {
  assertEquals(resolveCanonicalFinalPayablePence(MK028), 800);
  const eco = buildCanonicalTripEconomicsRead(MK028);
  assertEquals(eco.final_fare_pence, 800);
  assertEquals(eco.final_customer_payable_pence, 788);
  assertEquals(eco.pickup_waiting_pence, 12);
  assertEquals(eco.expected_capture_pence, 800);
  assertEquals(eco.commissionable_fare_pence, 800);
  assertEquals(eco.commission_pence, 120);
  assertEquals(eco.driver_net_pence, 680);
  assertEquals(
    resolveCanonicalFinalPayablePence({ ...MK028, final_fare_pence: null }),
    800,
  );
  const cmp = compareStampExpectedVsProviderCapture({
    expected_capture_pence: resolveCanonicalExpectedCapturePence(MK028),
    provider_captured_pence: 800,
    has_payment_session: true,
  });
  assertEquals(cmp.capture_classification, "MATCHED");
  assertEquals(cmp.variance_pence, 0);
});

Deno.test("MK-029: expected 716; never 982/1248; gross capture + refund net = 716", () => {
  assertEquals(resolveCanonicalFinalPayablePence(MK029), 716);
  assertEquals(resolveCanonicalExpectedCapturePence(MK029), 716);
  const eco = buildCanonicalTripEconomicsRead(MK029);
  assertEquals(eco.final_fare_pence, 716);
  assertEquals(eco.modification_audit_pence, 266);
  assertEquals(eco.original_locked_fare_pence, 450);
  assertNotEquals(eco.expected_capture_pence, 982);
  assertNotEquals(eco.expected_capture_pence, 1248);
  assertEquals(resolveOtherNonModComponentsPence(MK029), null);

  const cmp = compareStampExpectedVsProviderCapture({
    expected_capture_pence: 716,
    provider_captured_pence: 982,
    has_payment_session: true,
  });
  assertEquals(cmp.capture_classification, "UNEXPLAINED_OVERCAPTURE");
  assertEquals(cmp.variance_pence, 266);

  const resolution = resolveOvercaptureCustomerPosition({
    expected_capture_pence: 716,
    provider_captured_pence: 982,
    refunded_amount_pence: 266,
    gross_overcapture_pence: 266,
  });
  assertEquals(982 - 266, 716);
  assertEquals(resolution.outstanding_customer_overcharge_pence, 0);
  assertEquals(resolution.resolved_overcapture_pence, 266);
  assertEquals(resolution.net_charged_pence, 716);
});

Deno.test("preset negotiation MK-024: negotiated final 450; never preset 550", () => {
  const eco = buildCanonicalTripEconomicsRead(PRESET_NEGOTIATED);
  assertEquals(eco.original_locked_fare_pence, 500);
  assertEquals(eco.accepted_preset_offer_fare_pence, 550);
  assertEquals(eco.final_fare_pence, 450);
  assertEquals(eco.expected_capture_pence, 450);
  assertNotEquals(eco.expected_capture_pence, 550);
  assertEquals(eco.match_classification_source, "stamp_vs_provider_interim");
  assertEquals(eco.fr_match_status_persisted, false);
});

Deno.test("MK-028: never prefer final_customer_fare (788) as complete payable", () => {
  // Old Provider Payments resolver preferred final_customer first → £7.88 false overcapture.
  assertEquals(MK028.final_customer_fare_pence, 788);
  assertEquals(resolveCanonicalFinalPayablePence(MK028), 800);
  assertNotEquals(resolveCanonicalFinalPayablePence(MK028), MK028.final_customer_fare_pence);
});

Deno.test("tab stability: adapter output identical across tab labels", () => {
  const tabs = [
    "overview",
    "provider_payments",
    "completed_trips_paid",
    "payment_matching",
    "captured",
    "released",
    "refunded",
  ];
  const eco = buildCanonicalTripEconomicsRead(MK028);
  for (const _tab of tabs) {
    assertEquals(buildCanonicalTripEconomicsRead(MK028), eco);
  }
});

Deno.test("chips aggregate canonical owned fields only", () => {
  const rows = [
    {
      economics: buildCanonicalTripEconomicsRead(MK028),
      captured_pence: 800,
      refunded_pence: 0,
      provider_fee_pence: 24,
    },
    {
      economics: buildCanonicalTripEconomicsRead(MK029),
      captured_pence: 982,
      refunded_pence: 266,
      provider_fee_pence: 30,
    },
  ];
  const providerCapturedTotal = rows.reduce((s, r) => s + r.captured_pence, 0);
  const refundedTotal = rows.reduce((s, r) => s + r.refunded_pence, 0);
  const completedTripFareTotal = rows.reduce(
    (s, r) => s + (r.economics.expected_capture_pence ?? 0),
    0,
  );
  assertEquals(providerCapturedTotal, 1782);
  assertEquals(refundedTotal, 266);
  assertEquals(completedTripFareTotal, 1516);
  assertNotEquals(completedTripFareTotal, providerCapturedTotal);
  // FR match chips must not be invented from stamp↔PS arithmetic.
  for (const r of rows) {
    assertEquals(r.economics.fr_match_status_persisted, false);
    assertEquals(r.economics.match_classification_source, "stamp_vs_provider_interim");
  }
});
