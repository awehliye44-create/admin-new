/**
 * Payment Sessions (SSOT) — capture breakdown + legitimate variance classification.
 * Owns explanation of every captured penny. No React money math.
 *
 * Prefer canonical_expected_capture_pence from tripFareSSOT.computeCaptureAmount
 * (same path as revolutCompletionCapture). Do not invent a second fare formula.
 */

export type PaymentSessionCaptureClassification =
  | "CAPTURED_MATCHED"
  | "CAPTURED_WITH_WAITING_TIME"
  | "CAPTURED_WITH_STOP_WAITING"
  | "CAPTURED_WITH_NO_SHOW_CHARGE"
  | "CAPTURED_WITH_ADDITIONAL_CHARGES"
  | "CAPTURE_SHORTFALL"
  | "UNEXPLAINED_OVERCAPTURE"
  | "UNEXPLAINED_SHORTFALL"
  | "CAPTURE_AMOUNT_UNKNOWN"
  | "EXPECTED_CAPTURE_UNKNOWN";

export type PaymentSessionCaptureBreakdown = {
  ride_fare_pence: number | null;
  pickup_waiting_charge_pence: number | null;
  stop_waiting_charge_pence: number | null;
  no_show_charge_pence: number | null;
  airport_charge_pence: number | null;
  toll_charge_pence: number | null;
  parking_charge_pence: number | null;
  extra_stop_charge_pence: number | null;
  manual_adjustment_pence: number | null;
  destination_change_pence: number | null;
  tip_pence: number | null;
  other_payment_component_pence: number | null;
  expected_capture_pence: number | null;
  provider_captured_pence: number | null;
  variance_pence: number | null;
  variance_reason: string | null;
  capture_classification: PaymentSessionCaptureClassification;
};

export type PaymentSessionCaptureBreakdownInput = {
  ride_fare_pence?: number | null;
  pickup_waiting_charge_pence?: number | null;
  stop_waiting_charge_pence?: number | null;
  no_show_charge_pence?: number | null;
  airport_charge_pence?: number | null;
  toll_charge_pence?: number | null;
  parking_charge_pence?: number | null;
  extra_stop_charge_pence?: number | null;
  manual_adjustment_pence?: number | null;
  destination_change_pence?: number | null;
  tip_pence?: number | null;
  other_payment_component_pence?: number | null;
  /**
   * Preferred: tripFareSSOT.computeCaptureAmount(...).capture_amount_pence
   * When null, falls back to sum of known components (never invents missing).
   */
  canonical_expected_capture_pence?: number | null;
  provider_captured_pence?: number | null;
};

const TOLERANCE_PENCE = 1;

/** Confirmed money: null stays null; never invent £0 from unknown. Non-negative only. */
export function nullableComponentPence(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/** Treat null components as 0 only when summing known rows that are explicitly present as 0. */
function componentOrZero(v: number | null): number {
  return v == null ? 0 : v;
}

function sumKnownComponents(parts: Array<number | null>): number | null {
  // If every component is null, expected is unknown.
  if (parts.every((p) => p == null)) return null;
  return parts.reduce<number>((s, p) => s + componentOrZero(p), 0);
}

function countPositive(parts: Array<number | null>): number {
  return parts.filter((p) => p != null && p > 0).length;
}

export function classifyPaymentSessionCaptureVariance(args: {
  expected_capture_pence: number | null;
  provider_captured_pence: number | null;
  pickup_waiting_charge_pence: number | null;
  stop_waiting_charge_pence: number | null;
  no_show_charge_pence: number | null;
  additional_legitimate_count: number;
}): {
  capture_classification: PaymentSessionCaptureClassification;
  variance_pence: number | null;
  variance_reason: string | null;
} {
  const expected = args.expected_capture_pence;
  const actual = args.provider_captured_pence;

  if (expected == null) {
    return {
      capture_classification: "EXPECTED_CAPTURE_UNKNOWN",
      variance_pence: null,
      variance_reason: "Expected capture unavailable",
    };
  }
  if (actual == null) {
    return {
      capture_classification: "CAPTURE_AMOUNT_UNKNOWN",
      variance_pence: null,
      variance_reason: "Provider captured amount unavailable",
    };
  }

  const variance = actual - expected;
  const matched = Math.abs(variance) <= TOLERANCE_PENCE;

  if (matched) {
    const pickup = args.pickup_waiting_charge_pence ?? 0;
    const stop = args.stop_waiting_charge_pence ?? 0;
    const noShow = args.no_show_charge_pence ?? 0;
    const extras = args.additional_legitimate_count;

    const positiveKinds =
      (pickup > 0 ? 1 : 0)
      + (stop > 0 ? 1 : 0)
      + (noShow > 0 ? 1 : 0)
      + (extras > 0 ? 1 : 0);

    if (positiveKinds > 1 || (extras > 1)) {
      return {
        capture_classification: "CAPTURED_WITH_ADDITIONAL_CHARGES",
        variance_pence: 0,
        variance_reason: "Multiple legitimate payment components",
      };
    }
    if (noShow > 0) {
      return {
        capture_classification: "CAPTURED_WITH_NO_SHOW_CHARGE",
        variance_pence: 0,
        variance_reason: "No-show charge",
      };
    }
    if (stop > 0) {
      return {
        capture_classification: "CAPTURED_WITH_STOP_WAITING",
        variance_pence: 0,
        variance_reason: "Stop waiting time",
      };
    }
    if (pickup > 0) {
      return {
        capture_classification: "CAPTURED_WITH_WAITING_TIME",
        variance_pence: 0,
        variance_reason: "Pickup waiting time",
      };
    }
    return {
      capture_classification: "CAPTURED_MATCHED",
      variance_pence: 0,
      variance_reason: null,
    };
  }

  if (variance > 0) {
    return {
      capture_classification: "UNEXPLAINED_OVERCAPTURE",
      variance_pence: variance,
      variance_reason: "Unexplained amount above legitimate capture components",
    };
  }

  return {
    capture_classification: "UNEXPLAINED_SHORTFALL",
    variance_pence: variance,
    variance_reason: "Captured below expected after legitimate components",
  };
}

/**
 * Build Payment Sessions capture breakdown from canonical trip components + provider capture.
 * Does not invent component amounts — null stays null.
 */
export function buildPaymentSessionCaptureBreakdown(
  input: PaymentSessionCaptureBreakdownInput,
): PaymentSessionCaptureBreakdown {
  const ride = nullableComponentPence(input.ride_fare_pence);
  const pickup = nullableComponentPence(input.pickup_waiting_charge_pence);
  const stop = nullableComponentPence(input.stop_waiting_charge_pence);
  const noShow = nullableComponentPence(input.no_show_charge_pence);
  const airport = nullableComponentPence(input.airport_charge_pence);
  const toll = nullableComponentPence(input.toll_charge_pence);
  const parking = nullableComponentPence(input.parking_charge_pence);
  const extraStop = nullableComponentPence(input.extra_stop_charge_pence);
  const manual = nullableComponentPence(input.manual_adjustment_pence);
  const destination = nullableComponentPence(input.destination_change_pence);
  const tip = nullableComponentPence(input.tip_pence);
  const other = nullableComponentPence(input.other_payment_component_pence);
  const provider = nullableComponentPence(input.provider_captured_pence);

  const canonical = nullableComponentPence(input.canonical_expected_capture_pence);
  const summed = sumKnownComponents([
    ride,
    pickup,
    stop,
    noShow,
    airport,
    toll,
    parking,
    extraStop,
    manual,
    destination,
    tip,
    other,
  ]);
  const expected = canonical ?? summed;

  const additionalLegitimate = countPositive([
    airport,
    toll,
    parking,
    extraStop,
    manual,
    destination,
    tip,
    other,
  ]);

  const classified = classifyPaymentSessionCaptureVariance({
    expected_capture_pence: expected,
    provider_captured_pence: provider,
    pickup_waiting_charge_pence: pickup,
    stop_waiting_charge_pence: stop,
    no_show_charge_pence: noShow,
    additional_legitimate_count: additionalLegitimate,
  });

  // Prefer CAPTURE_SHORTFALL label when short and unexplained (match status alias).
  let classification = classified.capture_classification;
  if (classification === "UNEXPLAINED_SHORTFALL") {
    classification = "CAPTURE_SHORTFALL";
  }

  return {
    ride_fare_pence: ride,
    pickup_waiting_charge_pence: pickup,
    stop_waiting_charge_pence: stop,
    no_show_charge_pence: noShow,
    airport_charge_pence: airport,
    toll_charge_pence: toll,
    parking_charge_pence: parking,
    extra_stop_charge_pence: extraStop,
    manual_adjustment_pence: manual,
    destination_change_pence: destination,
    tip_pence: tip,
    other_payment_component_pence: other,
    expected_capture_pence: expected,
    provider_captured_pence: provider,
    variance_pence: classified.variance_pence,
    variance_reason: classified.variance_reason,
    capture_classification: classification,
  };
}

/** Map breakdown classification → Payment Matching status (reconcile status). */
export function captureClassificationToMatchStatus(
  classification: PaymentSessionCaptureClassification,
):
  | "MATCHED"
  | "CAPTURE_SHORTFALL"
  | "OVERCAPTURE"
  | "UNEXPLAINED_OVERCAPTURE"
  | "TRIP_FARE_UNAVAILABLE"
  | "CAPTURE_EVIDENCE_PENDING" {
  switch (classification) {
    case "CAPTURED_MATCHED":
    case "CAPTURED_WITH_WAITING_TIME":
    case "CAPTURED_WITH_STOP_WAITING":
    case "CAPTURED_WITH_NO_SHOW_CHARGE":
    case "CAPTURED_WITH_ADDITIONAL_CHARGES":
      return "MATCHED";
    case "CAPTURE_SHORTFALL":
    case "UNEXPLAINED_SHORTFALL":
      return "CAPTURE_SHORTFALL";
    case "UNEXPLAINED_OVERCAPTURE":
      return "UNEXPLAINED_OVERCAPTURE";
    case "EXPECTED_CAPTURE_UNKNOWN":
      return "TRIP_FARE_UNAVAILABLE";
    case "CAPTURE_AMOUNT_UNKNOWN":
      return "CAPTURE_EVIDENCE_PENDING";
    default:
      return "CAPTURE_EVIDENCE_PENDING";
  }
}
