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

/** Trip evidence fields Payment Sessions may read to build the capture breakdown. */
export type PaymentSessionCaptureTripEvidence = {
  final_customer_fare_pence?: number | null;
  commissionable_fare_pence?: number | null;
  locked_base_fare_pence?: number | null;
  gross_fare_pence?: number | null;
  final_fare_pence?: number | null;
  pickup_waiting_charge_pence?: number | null;
  stop_waiting_charge_pence?: number | null;
  stop_charge_total_pence?: number | null;
  no_show_charge_pence?: number | null;
  airport_charge_pence?: number | null;
  tip_pence?: number | null;
  tip_amount_pence?: number | null;
  extras_pence?: number | null;
  customer_modification_charge_pence?: number | null;
  destination_change_adjustment_pence?: number | null;
  other_pass_through_charges_pence?: number | null;
};

const TOLERANCE_PENCE = 1;

/** Confirmed money: null stays null; never invent £0 from unknown. Non-negative only. */
export function nullableComponentPence(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function componentOrZero(v: number | null): number {
  return v == null ? 0 : v;
}

function sumKnownComponents(parts: Array<number | null>): number | null {
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

    if (positiveKinds > 1 || extras > 1) {
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
    const pickup = args.pickup_waiting_charge_pence ?? 0;
    const stop = args.stop_waiting_charge_pence ?? 0;
    const noShow = args.no_show_charge_pence ?? 0;
    // Safety net: positive delta fully explained by a legitimate component
    // even when expected omitted that component (stale final_fare).
    if (pickup > 0 && Math.abs(variance - pickup) <= TOLERANCE_PENCE) {
      return {
        capture_classification: "CAPTURED_WITH_WAITING_TIME",
        variance_pence: 0,
        variance_reason: "Pickup waiting time",
      };
    }
    if (stop > 0 && Math.abs(variance - stop) <= TOLERANCE_PENCE) {
      return {
        capture_classification: "CAPTURED_WITH_STOP_WAITING",
        variance_pence: 0,
        variance_reason: "Stop waiting time",
      };
    }
    if (noShow > 0 && Math.abs(variance - noShow) <= TOLERANCE_PENCE) {
      return {
        capture_classification: "CAPTURED_WITH_NO_SHOW_CHARGE",
        variance_pence: 0,
        variance_reason: "No-show charge",
      };
    }
    const waitingTotal = pickup + stop;
    if (
      waitingTotal > 0
      && Math.abs(variance - waitingTotal) <= TOLERANCE_PENCE
    ) {
      return {
        capture_classification: "CAPTURED_WITH_ADDITIONAL_CHARGES",
        variance_pence: 0,
        variance_reason: "Multiple legitimate payment components",
      };
    }
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
  // Prefer the fuller of canonical vs component sum. Stale final_fare that omits
  // waiting/no-show must never become expected and invent UNEXPLAINED_OVERCAPTURE.
  const expected =
    canonical != null && summed != null
      ? Math.max(canonical, summed)
      : (canonical ?? summed);

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

/**
 * Payment Sessions–owned entry point for completed-trip capture explanation.
 * FR must call this or readPersistedCaptureBreakdown — never invent reasons locally.
 */
export function buildCaptureBreakdownForCompletedTrip(args: {
  trip: PaymentSessionCaptureTripEvidence;
  provider_captured_pence: number | null;
  canonical_expected_capture_pence?: number | null;
}): PaymentSessionCaptureBreakdown {
  const trip = args.trip;
  const ride = nullableComponentPence(
    trip.final_customer_fare_pence
      ?? trip.commissionable_fare_pence
      ?? trip.locked_base_fare_pence
      ?? trip.gross_fare_pence,
  );
  const pickup = nullableComponentPence(trip.pickup_waiting_charge_pence);
  const stop = nullableComponentPence(
    trip.stop_waiting_charge_pence ?? trip.stop_charge_total_pence,
  );
  const noShow = nullableComponentPence(trip.no_show_charge_pence);
  const airport = nullableComponentPence(trip.airport_charge_pence);
  const tip = nullableComponentPence(trip.tip_pence ?? trip.tip_amount_pence);
  const extras = nullableComponentPence(trip.extras_pence);
  const manual = nullableComponentPence(trip.customer_modification_charge_pence);
  const destination = nullableComponentPence(trip.destination_change_adjustment_pence);
  const other = nullableComponentPence(trip.other_pass_through_charges_pence);

  const persistedFinal = nullableComponentPence(trip.final_fare_pence);
  const canonical = nullableComponentPence(args.canonical_expected_capture_pence)
    ?? persistedFinal;

  return buildPaymentSessionCaptureBreakdown({
    ride_fare_pence: ride,
    pickup_waiting_charge_pence: pickup,
    stop_waiting_charge_pence: stop,
    no_show_charge_pence: noShow,
    airport_charge_pence: airport,
    toll_charge_pence: null,
    parking_charge_pence: null,
    extra_stop_charge_pence: extras,
    manual_adjustment_pence: manual,
    destination_change_pence: destination,
    tip_pence: tip,
    other_payment_component_pence: other,
    canonical_expected_capture_pence: canonical,
    provider_captured_pence: args.provider_captured_pence,
  });
}

/** Read a previously persisted Payment Sessions capture breakdown from session metadata. */
export function readPersistedCaptureBreakdown(
  metadata: unknown,
): PaymentSessionCaptureBreakdown | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>).capture_breakdown;
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const classification = b.capture_classification;
  if (typeof classification !== "string" || !classification) return null;
  return {
    ride_fare_pence: nullableComponentPence(b.ride_fare_pence as number | null),
    pickup_waiting_charge_pence: nullableComponentPence(b.pickup_waiting_charge_pence as number | null),
    stop_waiting_charge_pence: nullableComponentPence(b.stop_waiting_charge_pence as number | null),
    no_show_charge_pence: nullableComponentPence(b.no_show_charge_pence as number | null),
    airport_charge_pence: nullableComponentPence(b.airport_charge_pence as number | null),
    toll_charge_pence: nullableComponentPence(b.toll_charge_pence as number | null),
    parking_charge_pence: nullableComponentPence(b.parking_charge_pence as number | null),
    extra_stop_charge_pence: nullableComponentPence(b.extra_stop_charge_pence as number | null),
    manual_adjustment_pence: nullableComponentPence(b.manual_adjustment_pence as number | null),
    destination_change_pence: nullableComponentPence(b.destination_change_pence as number | null),
    tip_pence: nullableComponentPence(b.tip_pence as number | null),
    other_payment_component_pence: nullableComponentPence(b.other_payment_component_pence as number | null),
    expected_capture_pence: nullableComponentPence(b.expected_capture_pence as number | null),
    provider_captured_pence: nullableComponentPence(b.provider_captured_pence as number | null),
    variance_pence: b.variance_pence == null ? null : Number(b.variance_pence),
    variance_reason: typeof b.variance_reason === "string" ? b.variance_reason : null,
    capture_classification: classification as PaymentSessionCaptureClassification,
  };
}

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
