/**
 * Fare capture outcome classification — tip failures must never be stamped as
 * fare payment_shortfall. Used by applyCompleteTripCaptureOutcome and
 * tripCaptureJobSSOT failed_terminal alert routing.
 */

/** Tip-window / tip-auth outcomes (not fare shortfall). */
export function isTipCaptureOutcomeStatus(status: string): boolean {
  const s = String(status ?? "").toLowerCase().trim();
  if (!s) return false;
  if (s.startsWith("tip_")) return true;
  if (s.includes("tip_authorisation") || s.includes("tip_authorization")) return true;
  if (s.includes("tip_window")) return true;
  if (s.includes("tip_not_collected")) return true;
  if (s === "tip_shortfall" || s.includes("tip_shortfall")) return true;
  return false;
}

/**
 * Fare-side durable recovery / shortfall / incremental statuses.
 * Explicitly excludes tip-capture outcomes even if the string contains
 * "shortfall" / "authorisation" substrings.
 */
export function isFareDurableRecoveryStatus(status: string): boolean {
  const s = String(status ?? "").toLowerCase().trim();
  if (!s || isTipCaptureOutcomeStatus(s)) return false;
  return (
    s.includes("shortfall") ||
    s.includes("recovery") ||
    s.includes("partial_capture") ||
    s.includes("additional_authorisation") ||
    s.includes("additional_authorization") ||
    s.includes("incremental")
  );
}

/** Statuses that may stamp trips.payment_status = payment_shortfall (fare only). */
export function isFarePaymentShortfallStatus(status: string): boolean {
  const s = String(status ?? "").toLowerCase().trim();
  if (!s || isTipCaptureOutcomeStatus(s)) return false;
  return (
    s.includes("shortfall") ||
    s.includes("recovery") ||
    s.includes("partial_capture")
  );
}
