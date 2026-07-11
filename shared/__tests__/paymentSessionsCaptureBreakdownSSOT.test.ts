import { describe, expect, it } from "vitest";
import {
  buildCaptureBreakdownForCompletedTrip,
  buildPaymentSessionCaptureBreakdown,
  captureClassificationToMatchStatus,
  readPersistedCaptureBreakdown,
} from "../paymentSessionsCaptureBreakdownSSOT";

describe("paymentSessionsCaptureBreakdownSSOT", () => {
  it("MK-260708-008: 680 + pickup waiting 18 + capture 698 → CAPTURED_WITH_WAITING_TIME", () => {
    const b = buildPaymentSessionCaptureBreakdown({
      ride_fare_pence: 680,
      pickup_waiting_charge_pence: 18,
      stop_waiting_charge_pence: 0,
      tip_pence: 0,
      airport_charge_pence: 0,
      canonical_expected_capture_pence: 698,
      provider_captured_pence: 698,
    });
    expect(b.expected_capture_pence).toBe(698);
    expect(b.provider_captured_pence).toBe(698);
    expect(b.variance_pence).toBe(0);
    expect(b.variance_reason).toBe("Pickup waiting time");
    expect(b.capture_classification).toBe("CAPTURED_WITH_WAITING_TIME");
    expect(captureClassificationToMatchStatus(b.capture_classification)).toBe("MATCHED");
  });

  it("stale canonical 680 + pickup 18 + capture 698 → waiting match, not OVERCAPTURE", () => {
    const b = buildPaymentSessionCaptureBreakdown({
      ride_fare_pence: 680,
      pickup_waiting_charge_pence: 18,
      stop_waiting_charge_pence: 0,
      tip_pence: 0,
      airport_charge_pence: 0,
      // Stale final_fare that omitted waiting — component sum owns expected.
      canonical_expected_capture_pence: 680,
      provider_captured_pence: 698,
    });
    expect(b.expected_capture_pence).toBe(698);
    expect(b.variance_pence).toBe(0);
    expect(b.capture_classification).toBe("CAPTURED_WITH_WAITING_TIME");
    expect(captureClassificationToMatchStatus(b.capture_classification)).toBe("MATCHED");
  });

  it("base 680 + no waiting + capture 698 → UNEXPLAINED_OVERCAPTURE +18", () => {
    const b = buildPaymentSessionCaptureBreakdown({
      ride_fare_pence: 680,
      pickup_waiting_charge_pence: 0,
      canonical_expected_capture_pence: 680,
      provider_captured_pence: 698,
    });
    expect(b.variance_pence).toBe(18);
    expect(b.capture_classification).toBe("UNEXPLAINED_OVERCAPTURE");
    expect(captureClassificationToMatchStatus(b.capture_classification)).toBe("UNEXPLAINED_OVERCAPTURE");
  });

  it("base 680 + no-show 300 + capture 980 → CAPTURED_WITH_NO_SHOW_CHARGE", () => {
    const b = buildPaymentSessionCaptureBreakdown({
      ride_fare_pence: 680,
      no_show_charge_pence: 300,
      canonical_expected_capture_pence: 980,
      provider_captured_pence: 980,
    });
    expect(b.capture_classification).toBe("CAPTURED_WITH_NO_SHOW_CHARGE");
    expect(b.variance_pence).toBe(0);
    expect(b.variance_reason).toBe("No-show charge");
  });

  it("multiple legitimate extras → CAPTURED_WITH_ADDITIONAL_CHARGES", () => {
    const b = buildPaymentSessionCaptureBreakdown({
      ride_fare_pence: 680,
      pickup_waiting_charge_pence: 18,
      airport_charge_pence: 500,
      tip_pence: 100,
      canonical_expected_capture_pence: 1298,
      provider_captured_pence: 1298,
    });
    expect(b.capture_classification).toBe("CAPTURED_WITH_ADDITIONAL_CHARGES");
    expect(b.variance_pence).toBe(0);
  });

  it("captured below expected → CAPTURE_SHORTFALL", () => {
    const b = buildPaymentSessionCaptureBreakdown({
      ride_fare_pence: 680,
      pickup_waiting_charge_pence: 18,
      canonical_expected_capture_pence: 698,
      provider_captured_pence: 600,
    });
    expect(b.capture_classification).toBe("CAPTURE_SHORTFALL");
    expect(b.variance_pence).toBe(-98);
  });

  it("NULL component fields stay null — never silently fabricated as positive amounts", () => {
    const b = buildPaymentSessionCaptureBreakdown({
      ride_fare_pence: 680,
      pickup_waiting_charge_pence: null,
      stop_waiting_charge_pence: null,
      tip_pence: null,
      airport_charge_pence: null,
      canonical_expected_capture_pence: 680,
      provider_captured_pence: 680,
    });
    expect(b.pickup_waiting_charge_pence).toBeNull();
    expect(b.tip_pence).toBeNull();
    expect(b.airport_charge_pence).toBeNull();
    expect(b.capture_classification).toBe("CAPTURED_MATCHED");
  });

  it("provider capture null → CAPTURE_AMOUNT_UNKNOWN", () => {
    const b = buildPaymentSessionCaptureBreakdown({
      ride_fare_pence: 680,
      canonical_expected_capture_pence: 680,
      provider_captured_pence: null,
    });
    expect(b.capture_classification).toBe("CAPTURE_AMOUNT_UNKNOWN");
    expect(b.variance_pence).toBeNull();
  });

  it("buildCaptureBreakdownForCompletedTrip maps trip evidence via PS-owned entry", () => {
    const b = buildCaptureBreakdownForCompletedTrip({
      trip: {
        final_customer_fare_pence: 680,
        pickup_waiting_charge_pence: 18,
        final_fare_pence: 698,
      },
      provider_captured_pence: 698,
      canonical_expected_capture_pence: 698,
    });
    expect(b.capture_classification).toBe("CAPTURED_WITH_WAITING_TIME");
    expect(b.variance_pence).toBe(0);
  });

  it("readPersistedCaptureBreakdown returns PS metadata without FR re-derivation", () => {
    const persisted = readPersistedCaptureBreakdown({
      capture_breakdown: {
        ride_fare_pence: 680,
        pickup_waiting_charge_pence: 18,
        stop_waiting_charge_pence: 0,
        tip_pence: 0,
        expected_capture_pence: 698,
        provider_captured_pence: 698,
        variance_pence: 0,
        variance_reason: "Pickup waiting time",
        capture_classification: "CAPTURED_WITH_WAITING_TIME",
      },
    });
    expect(persisted?.capture_classification).toBe("CAPTURED_WITH_WAITING_TIME");
    expect(persisted?.expected_capture_pence).toBe(698);
    expect(persisted?.variance_reason).toBe("Pickup waiting time");
  });
});
