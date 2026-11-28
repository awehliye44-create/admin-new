/**
 * MK-261105-002 modification hold liveness — pure helpers.
 * Every fare change (increase / decrease / zero-delta) on PLATFORM digital
 * trips requires a live authorisation covering the revised payable.
 */

export const MODIFICATION_UNCHANGED_CUSTOMER_MESSAGE =
  "We couldn't apply your change. Your trip details are unchanged";

export const MODIFICATION_CHALLENGE_UNSUPPORTED_CUSTOMER_MESSAGE =
  "Your bank needs extra verification for this change. That step isn’t available on a live trip yet. Your original trip is unchanged.";

export const TRIP_CANCELLED_PAYMENT_LOST_TITLE = "Trip cancelled";
export const TRIP_CANCELLED_PAYMENT_LOST_MESSAGE =
  "Your trip was cancelled because we couldn’t secure payment.";

export const BOOKING_CANCELLED_PAYMENT_LOST_TITLE = "Booking cancelled";
export const BOOKING_CANCELLED_PAYMENT_LOST_MESSAGE =
  "Your booking was cancelled because we couldn’t secure payment.";

/**
 * Trip has started (passenger journey underway).
 * Lost-auth here keeps the ride active and flags support recovery — does NOT cancel.
 * Pre-start statuses (scheduled / searching / en_route / arrived) still cancel.
 */
export const STARTED_TRIP_STATUSES = new Set([
  "in_progress",
  "started",
  "on_trip",
  "ongoing",
  "trip_started",
]);

export const MID_TRIP_AUTH_LOST_FLAG = "mid_trip_payment_auth_lost";

export function isStartedTripStatus(status: unknown): boolean {
  return STARTED_TRIP_STATUSES.has(String(status ?? "").toLowerCase());
}

/** True when further destination/stop changes must be refused. */
export function tripBlocksModificationsForUnresolvedPayment(trip: {
  payment_status?: unknown;
  payment_hold_status?: unknown;
  metadata?: unknown;
}): boolean {
  const paymentStatus = String(trip.payment_status ?? "").toLowerCase();
  const hold = String(trip.payment_hold_status ?? "").toLowerCase();
  const meta = trip.metadata && typeof trip.metadata === "object"
    ? trip.metadata as Record<string, unknown>
    : {};
  if (meta[MID_TRIP_AUTH_LOST_FLAG] === true) return true;
  if (paymentStatus === "recovery_required") return true;
  if (hold === "payment_shortfall" && paymentStatus === "recovery_required") return true;
  return false;
}

export type ModificationHoldLiveness =
  | { ok: true; authorisedPence: number; sessionId: string }
  | {
    ok: false;
    code:
      | "missing_session"
      | "releasing"
      | "released"
      | "expired"
      | "superseded"
      | "not_authorised"
      | "insufficient"
      | "wrong_trip";
    authorisedPence: number;
  };

/**
 * Authorisation coverage required for a modification.
 * Route payable (new_fare) plus accumulated waiting; prefers preview
 * new_customer_total when present (D1 / MK-261125).
 */
export function revisedPayablePenceForModification(args: {
  newFarePence: number | null | undefined;
  originalFarePence?: number | null | undefined;
  pickupWaitingChargePence?: number | null | undefined;
  stopWaitingChargePence?: number | null | undefined;
  newCustomerTotalPence?: number | null | undefined;
}): number {
  const neu = Math.max(0, Math.round(Number(args.newFarePence ?? 0)));
  const base = neu > 0
    ? neu
    : Math.max(0, Math.round(Number(args.originalFarePence ?? 0)));
  const waiting =
    Math.max(0, Math.round(Number(args.pickupWaitingChargePence ?? 0))) +
    Math.max(0, Math.round(Number(args.stopWaitingChargePence ?? 0)));
  const preview = Math.max(0, Math.round(Number(args.newCustomerTotalPence ?? 0)));
  return Math.max(base + waiting, preview, base);
}

export function isDigitalPlatformPaymentMethod(method: unknown): boolean {
  const m = String(method ?? "").toUpperCase();
  return m === "CARD" || m === "APPLE_PAY" || m === "GOOGLE_PAY";
}

export function lostAuthCustomerCopyForTripStatus(status: unknown): {
  title: string;
  message: string;
  kind: "booking_cancelled_payment" | "trip_cancelled_payment";
  /** Pre-start cancel only — started trips use recovery flag, not cancel. */
  inProgressCancelPolicyNeedsDecision: boolean;
} {
  // Started trips no longer cancel here; keep booking copy for pre-start cancels.
  void status;
  return {
    title: BOOKING_CANCELLED_PAYMENT_LOST_TITLE,
    message: BOOKING_CANCELLED_PAYMENT_LOST_MESSAGE,
    kind: "booking_cancelled_payment",
    inProgressCancelPolicyNeedsDecision: false,
  };
}

export const MODIFICATION_CHALLENGE_UNSUPPORTED_REJECTION =
  "modification_challenge_unsupported";

export function dedupeKeyForModificationUnchanged(requestId: string): string {
  return `modification_unchanged:tcr:${String(requestId).trim()}`;
}

export function dedupeKeyForModificationUnchangedAttempt(
  tripId: string,
  attemptId: string,
): string {
  return `modification_unchanged:trip:${String(tripId).trim()}:attempt:${String(attemptId).trim()}`;
}
