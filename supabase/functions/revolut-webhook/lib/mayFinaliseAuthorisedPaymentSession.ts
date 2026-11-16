/**
 * Bug #37 — late AUTHORISED after a Google Pay submit miss.
 *
 * Recoverable technical failure (`failed` with hold still open) may still
 * finalise when Revolut later reports AUTHORISED.
 *
 * Must NEVER finalise when the customer cancelled, the attempt was superseded
 * by a replacement payment, the hold was released, the session is orphaned, or
 * a trip already exists on this session.
 */
export function mayFinaliseAuthorisedPaymentSession(args: {
  sessionStatus: string | null | undefined;
  holdReleaseState?: string | null | undefined;
  tripId?: string | null | undefined;
  alreadyOrphaned?: boolean;
  metadata?: Record<string, unknown> | null;
}): boolean {
  if (args.tripId) return false;
  if (args.alreadyOrphaned) return false;

  const sessionStatus = String(args.sessionStatus ?? "").toLowerCase();
  const holdRelease = String(args.holdReleaseState ?? "").toLowerCase();
  const holdGone = holdRelease === "released" || holdRelease === "releasing";
  const meta =
    args.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)
      ? args.metadata
      : {};

  // Explicit cancel / release / orphan / superseded session statuses.
  if (
    [
      "cancelled",
      "canceled",
      "released",
      "superseded",
      "payment_orphaned",
      "orphan_authorisation",
      "abandoned",
      "expired",
    ].includes(sessionStatus)
  ) {
    return false;
  }

  // Metadata stamps from cancel / orphan / replacement workflows.
  if (meta.never_capture === true) return false;
  if (meta.release_recommended === true && holdGone) return false;
  if (meta.customer_cancelled === true) return false;
  if (meta.sheet_cancelled === true) return false;
  if (meta.payment_sheet_closed === true) return false;
  if (typeof meta.orphan_reason === "string" && meta.orphan_reason.length > 0) {
    return false;
  }
  if (
    meta.superseded_by_session_id ||
    meta.replaced_by_session_id ||
    meta.replacement_session_id ||
    meta.replacement_order_id
  ) {
    return false;
  }

  // Technical fail with hold already gone — do not revive.
  if (sessionStatus === "failed" && holdGone) return false;

  // failed (hold open) / pending_payment / processing / authorising → may finalise.
  return true;
}
