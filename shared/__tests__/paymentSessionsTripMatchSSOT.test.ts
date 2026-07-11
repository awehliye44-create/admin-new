import { describe, expect, it } from "vitest";
import { classifyPaymentTripMatch } from "../paymentSessionsTripMatchSSOT";

describe("classifyPaymentTripMatch", () => {
  it("MATCHED when fare £4.80 captured £4.80 (auth £7.80 / release £3.00)", () => {
    const r = classifyPaymentTripMatch({
      expected_capture_pence: 480,
      actual_capture_pence: 480,
      has_payment_session: true,
      has_trip_link: true,
      authorised_amount_pence: 780,
      actual_released_pence: 300,
    });
    expect(r.status).toBe("MATCHED");
    expect(r.variance_pence).toBe(0);
  });

  it("CAPTURE_SHORTFALL when fare £4.80 and confirmed capture £0", () => {
    const r = classifyPaymentTripMatch({
      expected_capture_pence: 480,
      actual_capture_pence: 0,
      has_payment_session: true,
      has_trip_link: true,
    });
    expect(r.status).toBe("CAPTURE_SHORTFALL");
    expect(r.shortfall_pence).toBe(480);
  });

  it("UNEXPLAINED_OVERCAPTURE when fare £4.80 and capture £7.80", () => {
    const r = classifyPaymentTripMatch({
      expected_capture_pence: 480,
      actual_capture_pence: 780,
      has_payment_session: true,
      has_trip_link: true,
    });
    expect(r.status).toBe("UNEXPLAINED_OVERCAPTURE");
    expect(r.overcapture_pence).toBe(300);
  });

  it("CAPTURE_EVIDENCE_PENDING when capture null (spec fallback — never treat auth as capture)", () => {
    const r = classifyPaymentTripMatch({
      expected_capture_pence: 480,
      actual_capture_pence: null,
      has_payment_session: true,
      has_trip_link: true,
      authorised_amount_pence: 780,
      provider_verification_status: "UNKNOWN",
    });
    expect(r.status).toBe("CAPTURE_EVIDENCE_PENDING");
    expect(r.variance_pence).toBeNull();
  });

  it("PROVIDER_VERIFICATION_PENDING when capture null and verification STALE/UNAVAILABLE", () => {
    expect(classifyPaymentTripMatch({
      expected_capture_pence: 480,
      actual_capture_pence: null,
      has_payment_session: true,
      has_trip_link: true,
      provider_verification_status: "STALE",
    }).status).toBe("PROVIDER_VERIFICATION_PENDING");

    expect(classifyPaymentTripMatch({
      expected_capture_pence: 480,
      actual_capture_pence: null,
      has_payment_session: true,
      has_trip_link: true,
      provider_verification_status: "UNAVAILABLE",
    }).status).toBe("PROVIDER_VERIFICATION_PENDING");
  });

  it("CAPTURE_MISSING when verified provider CAPTURED but amount still null", () => {
    const r = classifyPaymentTripMatch({
      expected_capture_pence: 480,
      actual_capture_pence: null,
      has_payment_session: true,
      has_trip_link: true,
      provider_verification_status: "VERIFIED",
      provider_state: "CAPTURED",
    });
    expect(r.status).toBe("CAPTURE_MISSING");
  });

  it("RELEASE_MISMATCH when capture matches but released buffer is wrong", () => {
    const r = classifyPaymentTripMatch({
      expected_capture_pence: 480,
      actual_capture_pence: 480,
      has_payment_session: true,
      has_trip_link: true,
      authorised_amount_pence: 780,
      actual_released_pence: 100,
    });
    expect(r.status).toBe("RELEASE_MISMATCH");
  });

  it("REFUND_MISMATCH when trip refund differs from provider refund", () => {
    const r = classifyPaymentTripMatch({
      expected_capture_pence: 480,
      actual_capture_pence: 480,
      has_payment_session: true,
      has_trip_link: true,
      authorised_amount_pence: 480,
      actual_released_pence: 0,
      expected_refund_pence: 100,
      actual_refund_pence: 50,
    });
    expect(r.status).toBe("REFUND_MISMATCH");
  });

  it("NO_PAYMENT_SESSION does not invent capture", () => {
    const r = classifyPaymentTripMatch({
      expected_capture_pence: 480,
      actual_capture_pence: null,
      has_payment_session: false,
      has_trip_link: true,
    });
    expect(r.status).toBe("NO_PAYMENT_SESSION");
  });

  it("TRIP_FARE_UNAVAILABLE when fare null", () => {
    const r = classifyPaymentTripMatch({
      expected_capture_pence: null,
      actual_capture_pence: 480,
      has_payment_session: true,
      has_trip_link: true,
    });
    expect(r.status).toBe("TRIP_FARE_UNAVAILABLE");
  });
});
