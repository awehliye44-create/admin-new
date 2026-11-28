/** Offline test/audit-only helpers; not part of Edge uploads. */
import { StampCaptureCompare } from "../../../functions/_shared/paymentSessionsCanonicalReadAdapterSSOT.ts";


/**
 * Compare Trip Fare stamp expected vs Payment Sessions captured.
 * Interim Admin compare only — FR does not yet persist per-session match_status.
 */
export function compareStampExpectedVsProviderCapture(args: {
  expected_capture_pence: number | null;
  provider_captured_pence: number | null;
  has_payment_session: boolean;
}): StampCaptureCompare {
  if (!args.has_payment_session) {
    return {
      expected_capture_pence: args.expected_capture_pence,
      provider_captured_pence: args.provider_captured_pence,
      variance_pence: null,
      capture_classification: "NO_PAYMENT_SESSION",
    };
  }
  const expected = args.expected_capture_pence;
  const actual = args.provider_captured_pence;
  if (expected == null || expected <= 0) {
    return {
      expected_capture_pence: expected,
      provider_captured_pence: actual,
      variance_pence: null,
      capture_classification: "TRIP_FARE_UNAVAILABLE",
    };
  }
  if (actual == null) {
    return {
      expected_capture_pence: expected,
      provider_captured_pence: actual,
      variance_pence: null,
      capture_classification: "CAPTURE_MISSING",
    };
  }
  const variance = actual - expected;
  if (variance === 0) {
    return {
      expected_capture_pence: expected,
      provider_captured_pence: actual,
      variance_pence: 0,
      capture_classification: "MATCHED",
    };
  }
  if (variance < 0) {
    return {
      expected_capture_pence: expected,
      provider_captured_pence: actual,
      variance_pence: variance,
      capture_classification: "CAPTURE_SHORTFALL",
    };
  }
  return {
    expected_capture_pence: expected,
    provider_captured_pence: actual,
    variance_pence: variance,
    capture_classification: "UNEXPLAINED_OVERCAPTURE",
  };
}

export * from "../../../functions/_shared/paymentSessionsCanonicalReadAdapterSSOT.ts";
