/**
 * Authoritative post-auth booking finalisation failure classification.
 * Webhook and CTAP must share the same definitive vs temporary rules.
 */

export type BookingFinalizeFailureClass =
  | "definitive_release"
  | "temporary_retry"
  | "adopt_existing_trip";

const DEFINITIVE_SUBSTRINGS = [
  "SCHEDULED_ADVANCE_WINDOW",
  "TOO_SOON",
  "TOO_FAR",
  "STALE_PAYMENT_ATTEMPT",
  "PICKUP_NO_LONGER_FEASIBLE",
  "DISABLED",
  "INVALID_SCHEDULED_AT",
  "CUSTOMER_ALREADY_HAS_ACTIVE_TRIP",
  "BOOKING_SNAPSHOT",
  "CAPTURE_COVERAGE",
  "PAYMENT_GATE",
  "assert_payment_gate",
  "FINANCIAL_MODEL",
  "INVALID_CONFIGURATION",
  "SERVICE_AREA",
  "NO_BOOKING_SNAPSHOT",
  "booking_snapshot_incomplete",
] as const;

const TEMPORARY_SUBSTRINGS = [
  "timeout",
  "timed out",
  "ECONNRESET",
  "ECONNREFUSED",
  "503",
  "502",
  "546",
  "BOOT_ERROR",
  "connection",
  "temporarily",
  "retry",
  "deadlock",
  "serialization",
  "could not serialize",
] as const;

export function classifyBookingFinalizeFailure(input: {
  message?: string | null;
  code?: string | null;
}): {
  class: BookingFinalizeFailureClass;
  existingTripId: string | null;
  terminalReason: string;
} {
  const msg = String(input.message ?? "");
  const code = String(input.code ?? "").trim();
  const hay = `${code} ${msg}`.toUpperCase();

  const existingTripMatch = msg.match(
    /CUSTOMER_ALREADY_HAS_ACTIVE_TRIP:([0-9a-f-]{36})/i,
  );
  if (existingTripMatch?.[1] || hay.includes("CUSTOMER_ALREADY_HAS_ACTIVE_TRIP")) {
    return {
      class: "adopt_existing_trip",
      existingTripId: existingTripMatch?.[1] ?? null,
      terminalReason: "customer_already_has_active_trip",
    };
  }

  for (const tip of TEMPORARY_SUBSTRINGS) {
    if (hay.includes(tip.toUpperCase())) {
      return {
        class: "temporary_retry",
        existingTripId: null,
        terminalReason: "temporary_finalize_failure",
      };
    }
  }

  for (const tip of DEFINITIVE_SUBSTRINGS) {
    if (hay.includes(tip.toUpperCase())) {
      return {
        class: "definitive_release",
        existingTripId: null,
        terminalReason: code || tip.toLowerCase(),
      };
    }
  }

  // Unknown finalize errors: treat as temporary (bounded recovery), not unsafe release.
  return {
    class: "temporary_retry",
    existingTripId: null,
    terminalReason: "unknown_finalize_failure",
  };
}

export const BOOKING_FAILED_HOLD_RELEASED_CUSTOMER_MESSAGE =
  "Your booking could not be completed. Any payment authorisation has been released. Please select a new pickup time and try again.";

/**
 * Financial outcome fields that must never be overwritten by caller `extraBody`
 * (e.g. advance validation codes must not replace BOOKING_FAILED_PREAUTH_REVERSED
 * or PAYMENT_ORPHANED).
 */
export const BOOKING_FAIL_FINANCIAL_RESPONSE_KEYS = [
  "code",
  "error",
  "charge_state",
  "reversal_status",
  "payment_intent_id",
  "success",
  "ride_id",
  "trip_id",
  "trip_code",
  "trip_reference",
  "status",
  "idempotent",
  "adopted_after_release_claim",
  "hold_released",
] as const;

/**
 * Merge optional CTAP failure extras without clobbering authoritative financial
 * outcome fields. Advance validation reasons belong in `advance_failure_code` /
 * `failure_reason`, never in `code` when a financial outcome code is set.
 */
export function mergeBookingFailExtraBody(
  base: Record<string, unknown>,
  extraBody?: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!extraBody || typeof extraBody !== "object") return base;
  const protectedKeys = new Set<string>(BOOKING_FAIL_FINANCIAL_RESPONSE_KEYS);
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extraBody)) {
    if (protectedKeys.has(key)) continue;
    safe[key] = value;
  }
  return { ...base, ...safe };
}
