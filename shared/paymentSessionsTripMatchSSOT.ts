/**
 * Payment Sessions ↔ completed-trip comparison (pure).
 * Provider amounts and trip fares are inputs only — never invent captures or fares.
 */

export type PaymentTripMatchStatus =
  | "MATCHED"
  | "CAPTURE_MISSING"
  | "CAPTURE_SHORTFALL"
  | "OVERCAPTURE"
  | "NO_PAYMENT_SESSION"
  | "NO_TRIP_LINK"
  | "PROVIDER_STATE_PENDING"
  | "RELEASE_MISMATCH"
  | "REFUND_MISMATCH"
  | "CAPTURE_EVIDENCE_PENDING"
  | "TRIP_FARE_UNAVAILABLE"
  | "PROVIDER_VERIFICATION_PENDING"
  | "TRIP_EVIDENCE_UNAVAILABLE";

export type PaymentTripMatchInput = {
  /** Canonical completed-trip final customer fare (pence). Null = unavailable. */
  expected_capture_pence: number | null;
  /** Provider-confirmed captured amount only. Null ≠ £0. */
  actual_capture_pence: number | null;
  has_payment_session: boolean;
  has_trip_link: boolean;
  trip_evidence_available?: boolean;
  provider_verification_status?: "VERIFIED" | "STALE" | "UNKNOWN" | "UNAVAILABLE" | null;
  /** True when provider state is still authorised / pending (not terminal capture). */
  provider_state_pending?: boolean;
};

export type PaymentTripMatchResult = {
  status: PaymentTripMatchStatus;
  /** actual − expected when both confirmed; else null. */
  variance_pence: number | null;
  shortfall_pence: number | null;
  overcapture_pence: number | null;
};

function confirmedPence(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/**
 * Compare provider-confirmed capture to completed-trip final fare.
 * Never treats authorised amount as captured. Never invents £0 from null.
 */
export function classifyPaymentTripMatch(input: PaymentTripMatchInput): PaymentTripMatchResult {
  if (input.trip_evidence_available === false) {
    return {
      status: "TRIP_EVIDENCE_UNAVAILABLE",
      variance_pence: null,
      shortfall_pence: null,
      overcapture_pence: null,
    };
  }

  if (!input.has_trip_link) {
    return {
      status: "NO_TRIP_LINK",
      variance_pence: null,
      shortfall_pence: null,
      overcapture_pence: null,
    };
  }

  if (!input.has_payment_session) {
    return {
      status: "NO_PAYMENT_SESSION",
      variance_pence: null,
      shortfall_pence: null,
      overcapture_pence: null,
    };
  }

  const verification = String(input.provider_verification_status ?? "").toUpperCase();
  if (verification === "UNAVAILABLE") {
    return {
      status: "PROVIDER_VERIFICATION_PENDING",
      variance_pence: null,
      shortfall_pence: null,
      overcapture_pence: null,
    };
  }

  const expected = confirmedPence(input.expected_capture_pence);
  if (expected == null) {
    return {
      status: "TRIP_FARE_UNAVAILABLE",
      variance_pence: null,
      shortfall_pence: null,
      overcapture_pence: null,
    };
  }

  const actual = confirmedPence(input.actual_capture_pence);
  if (actual == null) {
    if (input.provider_state_pending || verification === "STALE" || verification === "UNKNOWN") {
      return {
        status: input.provider_state_pending ? "PROVIDER_STATE_PENDING" : "CAPTURE_EVIDENCE_PENDING",
        variance_pence: null,
        shortfall_pence: null,
        overcapture_pence: null,
      };
    }
    return {
      status: "CAPTURE_EVIDENCE_PENDING",
      variance_pence: null,
      shortfall_pence: null,
      overcapture_pence: null,
    };
  }

  const variance = actual - expected;
  if (variance === 0) {
    return {
      status: "MATCHED",
      variance_pence: 0,
      shortfall_pence: null,
      overcapture_pence: null,
    };
  }
  if (actual === 0 && expected > 0) {
    return {
      status: "CAPTURE_SHORTFALL",
      variance_pence: variance,
      shortfall_pence: expected,
      overcapture_pence: null,
    };
  }
  if (variance < 0) {
    return {
      status: "CAPTURE_SHORTFALL",
      variance_pence: variance,
      shortfall_pence: Math.abs(variance),
      overcapture_pence: null,
    };
  }
  return {
    status: "OVERCAPTURE",
    variance_pence: variance,
    shortfall_pence: null,
    overcapture_pence: variance,
  };
}
