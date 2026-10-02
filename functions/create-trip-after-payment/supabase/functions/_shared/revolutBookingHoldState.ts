/**
 * P0 — Trip create / confirm / CTAP may ONLY treat a true Revolut hold as paid.
 * PENDING/PROCESSING are in-flight checkout states — never trip-authorised.
 * COMPLETED (captured) is handled separately (invariant / capture paths).
 *
 * Dependency-free so lean bundles (revolut-webhook) can import it.
 */
const BOOKING_PREAUTH_HOLD_STATES = new Set(["AUTHORISED"]);

/** True Revolut AUTHORISED hold only — never PENDING/PROCESSING. */
export function isRevolutBookingPreauthHoldState(state: string | undefined): boolean {
  return BOOKING_PREAUTH_HOLD_STATES.has(String(state ?? "").toUpperCase());
}
