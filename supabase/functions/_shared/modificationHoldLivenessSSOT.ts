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

/** Trip statuses where the customer is already mid-ride (cancel-fee policy may differ). */
export const IN_PROGRESS_LIKE_TRIP_STATUSES = new Set([
  "in_progress",
  "started",
  "on_trip",
  "ongoing",
  "trip_started",
  "en_route",
  "en_route_to_pickup",
  "driver_en_route",
  "enroute_to_pickup",
  "driver_arriving",
  "arrived",
  "arrived_pickup",
  "arrived_at_pickup",
  "at_pickup",
  "pickup_waiting",
  "waiting",
  "waiting_at_pickup",
]);

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

export function revisedPayablePenceForModification(args: {
  newFarePence: number | null | undefined;
  originalFarePence?: number | null | undefined;
}): number {
  const neu = Math.max(0, Math.round(Number(args.newFarePence ?? 0)));
  if (neu > 0) return neu;
  return Math.max(0, Math.round(Number(args.originalFarePence ?? 0)));
}

export function isDigitalPlatformPaymentMethod(method: unknown): boolean {
  const m = String(method ?? "").toUpperCase();
  return m === "CARD" || m === "APPLE_PAY" || m === "GOOGLE_PAY";
}

export function classifyPaymentSessionHoldLiveness(args: {
  session: {
    id?: unknown;
    trip_id?: unknown;
    provider_state?: unknown;
    status?: unknown;
    hold_release_state?: unknown;
    released_at?: unknown;
    captured_at?: unknown;
    authorised_amount_pence?: unknown;
    total_authorised_amount_pence?: unknown;
    metadata?: unknown;
  } | null | undefined;
  expectedTripId: string;
  requiredPayablePence: number;
}): ModificationHoldLiveness {
  const session = args.session;
  if (!session?.id) {
    return { ok: false, code: "missing_session", authorisedPence: 0 };
  }
  const sessionId = String(session.id);
  const sessionTrip = String(session.trip_id ?? "").trim();
  if (sessionTrip && sessionTrip !== String(args.expectedTripId).trim()) {
    return { ok: false, code: "wrong_trip", authorisedPence: 0 };
  }

  const meta = session.metadata && typeof session.metadata === "object"
    ? session.metadata as Record<string, unknown>
    : {};
  if (String(meta.never_capture ?? "") === "true") {
    return { ok: false, code: "superseded", authorisedPence: 0 };
  }

  const hold = String(session.hold_release_state ?? "").toLowerCase();
  if (hold === "releasing") {
    return { ok: false, code: "releasing", authorisedPence: 0 };
  }
  if (hold === "released" || (session.released_at && !session.captured_at)) {
    return { ok: false, code: "released", authorisedPence: 0 };
  }

  const provider = String(session.provider_state ?? "").toUpperCase();
  if (["CANCELLED", "CANCELED", "FAILED", "DECLINED", "EXPIRED"].includes(provider)) {
    return {
      ok: false,
      code: provider === "EXPIRED" ? "expired" : "not_authorised",
      authorisedPence: 0,
    };
  }
  if (!["AUTHORISED", "AUTHORIZED", "COMPLETED"].includes(provider)) {
    return { ok: false, code: "not_authorised", authorisedPence: 0 };
  }

  const status = String(session.status ?? "").toLowerCase();
  if (
    [
      "cancelled",
      "canceled",
      "failed",
      "expired",
      "abandoned",
      "payment_orphaned",
      "released",
      "orphan_authorisation",
    ].includes(status)
  ) {
    return {
      ok: false,
      code: status === "expired" ? "expired" : "not_authorised",
      authorisedPence: 0,
    };
  }

  const authorisedPence = Math.max(
    0,
    Math.round(Number(session.total_authorised_amount_pence ?? 0)),
    Math.round(Number(session.authorised_amount_pence ?? 0)),
  );
  const required = Math.max(0, Math.round(Number(args.requiredPayablePence)));
  if (required > 0 && authorisedPence < required) {
    return { ok: false, code: "insufficient", authorisedPence };
  }
  return { ok: true, authorisedPence, sessionId };
}

export function lostAuthCustomerCopyForTripStatus(status: unknown): {
  title: string;
  message: string;
  kind: "booking_cancelled_payment" | "trip_cancelled_payment";
  /**
   * FLAG: in-progress currently cancels with CANCELLED_NO_FEE.
   * Waiting-time / cancel-fee policy for mid-trip lost-auth needs a separate product decision.
   */
  inProgressCancelPolicyNeedsDecision: boolean;
} {
  const s = String(status ?? "").toLowerCase();
  if (IN_PROGRESS_LIKE_TRIP_STATUSES.has(s)) {
    return {
      title: TRIP_CANCELLED_PAYMENT_LOST_TITLE,
      message: TRIP_CANCELLED_PAYMENT_LOST_MESSAGE,
      kind: "trip_cancelled_payment",
      inProgressCancelPolicyNeedsDecision: true,
    };
  }
  return {
    title: BOOKING_CANCELLED_PAYMENT_LOST_TITLE,
    message: BOOKING_CANCELLED_PAYMENT_LOST_MESSAGE,
    kind: "booking_cancelled_payment",
    inProgressCancelPolicyNeedsDecision: false,
  };
}

export function dedupeKeyForModificationUnchanged(requestId: string): string {
  return `modification_unchanged:tcr:${String(requestId).trim()}`;
}

export function dedupeKeyForModificationUnchangedAttempt(
  tripId: string,
  attemptId: string,
): string {
  return `modification_unchanged:trip:${String(tripId).trim()}:attempt:${String(attemptId).trim()}`;
}
