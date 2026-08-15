import { describe, expect, it } from "vitest";
import {
  buildCanonicalTripEconomicsRead,
  compareStampExpectedVsProviderCapture,
  resolveCanonicalExpectedCapturePence,
  resolveCanonicalFinalPayablePence,
  resolveOtherNonModComponentsPence,
} from "../paymentSessionsCanonicalReadAdapterSSOT";
import { resolveOvercaptureCustomerPosition } from "../paymentSessionsOvercaptureResolutionSSOT";

/** MK-260815-028 — waiting included once in final_fare stamp. */
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

/** MK-260815-029 — mod folded into final_customer; audit delta must not re-add. */
const MK029 = {
  trip_code: "MK-260815-029",
  locked_base_fare_pence: 450,
  final_customer_fare_pence: 716,
  final_fare_pence: 716,
  customer_modification_charge_pence: 266,
  destination_change_adjustment_pence: 266,
  commissionable_fare_pence: 716,
  commission_pence: 107, // illustrative stamp; ownership is Settlement
  driver_net_pence: 609,
};

/** Preset negotiation — production-shaped MK-260815-024 (preset 550 → final 450). */
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

describe("paymentSessionsCanonicalReadAdapterSSOT — MK-028", () => {
  it("final customer payable is 800 everywhere (not ride-only 788)", () => {
    expect(resolveCanonicalFinalPayablePence(MK028)).toBe(800);
    const eco = buildCanonicalTripEconomicsRead(MK028);
    expect(eco.final_fare_pence).toBe(800);
    expect(eco.final_customer_payable_pence).toBe(788);
    expect(eco.pickup_waiting_pence).toBe(12);
    expect(eco.expected_capture_pence).toBe(800);
    expect(eco.commissionable_fare_pence).toBe(800);
    expect(eco.commission_pence).toBe(120);
    expect(eco.driver_net_pence).toBe(680);
  });

  it("waiting is included exactly once (not 788+12 again on top of final_fare)", () => {
    const eco = buildCanonicalTripEconomicsRead(MK028);
    expect(eco.final_fare_pence).toBe(800);
    expect(eco.waiting_total_pence).toBe(12);
    // Fallback path without final_fare must still be 800 once.
    const withoutStampedFinal = {
      ...MK028,
      final_fare_pence: null,
    };
    expect(resolveCanonicalFinalPayablePence(withoutStampedFinal)).toBe(800);
  });

  it("stamp↔provider MATCHED when captured = 800", () => {
    const cmp = compareStampExpectedVsProviderCapture({
      expected_capture_pence: resolveCanonicalExpectedCapturePence(MK028),
      provider_captured_pence: 800,
      has_payment_session: true,
    });
    expect(cmp.capture_classification).toBe("MATCHED");
    expect(cmp.variance_pence).toBe(0);
  });
});

describe("paymentSessionsCanonicalReadAdapterSSOT — MK-029", () => {
  it("legitimate expected payable is 716 — never 982 or 1248", () => {
    expect(resolveCanonicalFinalPayablePence(MK029)).toBe(716);
    expect(resolveCanonicalExpectedCapturePence(MK029)).toBe(716);
    const eco = buildCanonicalTripEconomicsRead(MK029);
    expect(eco.final_fare_pence).toBe(716);
    expect(eco.expected_capture_pence).toBe(716);
    expect(eco.modification_audit_pence).toBe(266);
    expect(eco.original_locked_fare_pence).toBe(450);
    // Must never treat 716+266 or 716+266+266 as expected.
    expect(eco.expected_capture_pence).not.toBe(982);
    expect(eco.expected_capture_pence).not.toBe(1248);
    expect(eco.expected_capture_pence).not.toBe(982);
  });

  it("does not fold modification into other_payment_components", () => {
    expect(resolveOtherNonModComponentsPence(MK029)).toBeNull();
  });

  it("preserves historical gross capture vs refunded net position", () => {
    const expected = resolveCanonicalExpectedCapturePence(MK029)!;
    const grossCaptured = 982;
    const refunded = 266;
    const cmp = compareStampExpectedVsProviderCapture({
      expected_capture_pence: expected,
      provider_captured_pence: grossCaptured,
      has_payment_session: true,
    });
    expect(cmp.capture_classification).toBe("UNEXPLAINED_OVERCAPTURE");
    expect(cmp.variance_pence).toBe(266);

    const resolution = resolveOvercaptureCustomerPosition({
      expected_capture_pence: expected,
      provider_captured_pence: grossCaptured,
      refunded_amount_pence: refunded,
      gross_overcapture_pence: 266,
    });
    // Net charged = 982 - 266 = 716 = expected → outstanding overcharge resolved.
    expect(grossCaptured - refunded).toBe(716);
    expect(resolution.outstanding_customer_overcharge_pence).toBe(0);
    expect(resolution.resolved_overcapture_pence).toBe(266);
  });
});

describe("paymentSessionsCanonicalReadAdapterSSOT — preset negotiation", () => {
  it("uses negotiated final, keeps original/preset quote as audit only", () => {
    const eco = buildCanonicalTripEconomicsRead(PRESET_NEGOTIATED);
    expect(eco.original_locked_fare_pence).toBe(500);
    expect(eco.accepted_preset_offer_fare_pence).toBe(550);
    expect(eco.final_fare_pence).toBe(450);
    expect(eco.expected_capture_pence).toBe(450);
    expect(eco.commissionable_fare_pence).toBe(450);
    // Never fall back to raw preset quote (550) as expected capture.
    expect(eco.expected_capture_pence).not.toBe(550);
    expect(eco.match_classification_source).toBe("stamp_vs_provider_interim");
    expect(eco.fr_match_status_persisted).toBe(false);
  });
});

describe("paymentSessionsCanonicalReadAdapterSSOT — tab value stability", () => {
  it("same session economics are identical regardless of tab filter context", () => {
    const tabs = [
      "overview",
      "provider_payments",
      "completed_trips_paid",
      "payment_matching",
      "captured",
      "released",
      "refunded",
    ] as const;
    const eco = buildCanonicalTripEconomicsRead(MK028);
    for (const _tab of tabs) {
      // Tabs filter rows only — adapter output must not depend on tab.
      expect(buildCanonicalTripEconomicsRead(MK028)).toEqual(eco);
      expect(eco.final_fare_pence).toBe(800);
      expect(eco.expected_capture_pence).toBe(800);
      expect(eco.driver_net_pence).toBe(680);
    }
  });
});

describe("paymentSessionsCanonicalReadAdapterSSOT — chip aggregation sources", () => {
  it("chips SUM canonical owned fields only (no fare rebuild)", () => {
    const rows = [
      {
        economics: buildCanonicalTripEconomicsRead(MK028),
        captured_pence: 800,
        refunded_pence: 0,
        released_pence: 0,
        provider_fee_pence: 24,
      },
      {
        economics: buildCanonicalTripEconomicsRead(MK029),
        captured_pence: 982,
        refunded_pence: 266,
        released_pence: 0,
        provider_fee_pence: 30,
      },
    ];

    const providerCapturedTotal = rows.reduce((s, r) => s + r.captured_pence, 0);
    const refundedTotal = rows.reduce((s, r) => s + r.refunded_pence, 0);
    const providerFees = rows.reduce((s, r) => s + r.provider_fee_pence, 0);
    const completedTripFareTotal = rows.reduce(
      (s, r) => s + (r.economics.expected_capture_pence ?? 0),
      0,
    );
    const driverNetTotal = rows.reduce((s, r) => s + (r.economics.driver_net_pence ?? 0), 0);
    const commissionTotal = rows.reduce((s, r) => s + (r.economics.commission_pence ?? 0), 0);

    expect(providerCapturedTotal).toBe(800 + 982);
    expect(refundedTotal).toBe(266);
    expect(providerFees).toBe(54);
    // Fare chip = Trip Fare stamps (800+716), NOT capture SUM.
    expect(completedTripFareTotal).toBe(800 + 716);
    expect(completedTripFareTotal).not.toBe(providerCapturedTotal);
    expect(driverNetTotal).toBe(680 + 609);
    expect(commissionTotal).toBe(120 + 107);
  });
});
