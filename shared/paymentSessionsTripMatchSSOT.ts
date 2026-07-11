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
  /** Authorised hold amount — used only for release-buffer checks after capture matches. */
  authorised_amount_pence?: number | null;
  /** Provider-confirmed released amount. Null ≠ £0. */
  actual_released_pence?: number | null;
  /** Trip-side expected refund (canonical). Null = no refund expected. */
  expected_refund_pence?: number | null;
  /** Provider-confirmed refunded amount. Null ≠ £0. */
  actual_refund_pence?: number | null;
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

function emptyResult(status: PaymentTripMatchStatus): PaymentTripMatchResult {
  return {
    status,
    variance_pence: null,
    shortfall_pence: null,
    overcapture_pence: null,
  };
}

/**
 * Compare provider-confirmed capture to completed-trip final fare.
 * Never treats authorised amount as captured. Never invents £0 from null.
 */
export function classifyPaymentTripMatch(input: PaymentTripMatchInput): PaymentTripMatchResult {
  if (input.trip_evidence_available === false) {
    return emptyResult("TRIP_EVIDENCE_UNAVAILABLE");
  }

  if (!input.has_trip_link) {
    return emptyResult("NO_TRIP_LINK");
  }

  if (!input.has_payment_session) {
    return emptyResult("NO_PAYMENT_SESSION");
  }

  const verification = String(input.provider_verification_status ?? "").toUpperCase();
  if (verification === "UNAVAILABLE") {
    return emptyResult("PROVIDER_VERIFICATION_PENDING");
  }

  const expected = confirmedPence(input.expected_capture_pence);
  if (expected == null) {
    return emptyResult("TRIP_FARE_UNAVAILABLE");
  }

  const actual = confirmedPence(input.actual_capture_pence);
  if (actual == null) {
    if (input.provider_state_pending) {
      return emptyResult("PROVIDER_STATE_PENDING");
    }
    // Verified provider evidence with no capture amount = missing capture (not pending).
    if (verification === "VERIFIED") {
      return emptyResult("CAPTURE_MISSING");
    }
    // STALE / UNKNOWN / unset — still waiting on evidence.
    return emptyResult("CAPTURE_EVIDENCE_PENDING");
  }

  const variance = actual - expected;
  if (variance !== 0) {
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

  // Capture matches fare — check release buffer then refund consistency.
  // Null released is not a mismatch (evidence may still be pending); wrong amount is.
  const authorised = confirmedPence(input.authorised_amount_pence);
  const released = confirmedPence(input.actual_released_pence);
  if (authorised != null && authorised >= actual && released != null) {
    const expectedRelease = authorised - actual;
    if (expectedRelease >= 0 && released !== expectedRelease) {
      return {
        status: "RELEASE_MISMATCH",
        variance_pence: 0,
        shortfall_pence: null,
        overcapture_pence: null,
      };
    }
  }

  const expectedRefund = confirmedPence(input.expected_refund_pence);
  const actualRefund = confirmedPence(input.actual_refund_pence);
  if (expectedRefund != null || actualRefund != null) {
    const exp = expectedRefund ?? 0;
    const act = actualRefund ?? 0;
    // Only mismatch when at least one side has a confirmed positive refund and they differ,
    // or one side is confirmed positive and the other is null (missing refund evidence).
    if (expectedRefund != null && actualRefund == null && expectedRefund > 0) {
      return {
        status: "REFUND_MISMATCH",
        variance_pence: 0,
        shortfall_pence: null,
        overcapture_pence: null,
      };
    }
    if (actualRefund != null && expectedRefund == null && actualRefund > 0) {
      return {
        status: "REFUND_MISMATCH",
        variance_pence: 0,
        shortfall_pence: null,
        overcapture_pence: null,
      };
    }
    if (expectedRefund != null && actualRefund != null && exp !== act) {
      return {
        status: "REFUND_MISMATCH",
        variance_pence: 0,
        shortfall_pence: null,
        overcapture_pence: null,
      };
    }
  }

  return {
    status: "MATCHED",
    variance_pence: 0,
    shortfall_pence: null,
    overcapture_pence: null,
  };
}
