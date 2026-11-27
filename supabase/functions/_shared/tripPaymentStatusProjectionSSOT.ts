/**
 * #108 — trips.payment_status must not regress after a provider-confirmed capture
 * or after an authoritative terminal hold release / void.
 *
 * MK-261126-005 / MK-261125-009: a late Revolut ORDER_AUTHORISED webhook wrote
 * payment_status=authorized after ORDER_COMPLETED had already set captured.
 * payment_hold_status and capture_amount_pence stayed captured, so the trip
 * row split. This predicate is the edge guard. The database trigger
 * trips_refuse_regressive_payment_status is the writer backstop.
 *
 * MK-261127-002: the same late AUTHORISED pattern rewrote authorized after a
 * NO_FEE_FULL_RELEASE (session released, provider CANCELLED). Capture guard
 * alone did not cover terminal void. Session/order identity must match so a
 * legitimate new payment attempt on a different order/session is not blocked.
 *
 * Confirmed capture evidence on the row is sticky against pre-capture statuses.
 * Legitimate captured → refunded / payment_shortfall writes are not pre-capture
 * and are left to those writers. No provider mutation.
 */

const PRE_CAPTURE_PAYMENT_STATUSES = new Set([
  "authorized",
  "authorised",
  "pending",
  "processing",
  "capture_requested",
  "capture_pending",
  "preauth_authorized",
  "preauth_authorised",
]);

const CONFIRMED_CAPTURE_PAYMENT_STATUSES = new Set([
  "captured",
  "paid",
  "completed",
]);

const TERMINAL_VOID_PAYMENT_STATUSES = new Set([
  "canceled",
  "cancelled",
]);

const TERMINAL_RELEASE_SESSION_STATUSES = new Set([
  "released",
  "released_after_recovery",
]);

const TERMINAL_VOID_PROVIDER_STATES = new Set([
  "cancelled",
  "canceled",
  "released",
]);

const TERMINAL_TRIP_STATUSES = new Set([
  "cancelled",
  "canceled",
  "no_show",
]);

export type TripPaymentStatusWriteDecision = {
  /** Status to persist when write is true. Current status when the write is skipped. */
  status: string;
  write: boolean;
  refusedRegression: boolean;
};

function norm(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function resolveTripPaymentStatusWrite(input: {
  currentStatus?: string | null;
  currentHoldStatus?: string | null;
  captureAmountPence?: number | null;
  incomingStatus: string;
  /**
   * Same RIDE_BOOKING payment_sessions row as the webhook provider_order_id.
   * When false/omitted without session evidence, terminal-release refuse is
   * limited to trip payment_status already canceled/cancelled.
   */
  sessionMatchesWebhookOrder?: boolean | null;
  sessionStatus?: string | null;
  holdReleaseState?: string | null;
  holdTerminalReason?: string | null;
  sessionProviderState?: string | null;
  tripStatus?: string | null;
}): TripPaymentStatusWriteDecision {
  const current = norm(input.currentStatus);
  const incoming = norm(input.incomingStatus);
  const hold = norm(input.currentHoldStatus);
  const capturePence = Math.round(Number(input.captureAmountPence ?? 0));
  const priorConfirmed = CONFIRMED_CAPTURE_PAYMENT_STATUSES.has(current);
  const rowConfirmed = hold === "captured" && Number.isFinite(capturePence) && capturePence > 0;
  const incomingPreCapture = PRE_CAPTURE_PAYMENT_STATUSES.has(incoming);

  if (incomingPreCapture && (priorConfirmed || rowConfirmed)) {
    const kept = priorConfirmed ? (input.currentStatus ?? "captured") : "captured";
    return {
      status: String(kept),
      write: !priorConfirmed,
      refusedRegression: true,
    };
  }

  // Already terminally voided on the trip projection — refuse AUTHORISED echo.
  if (incomingPreCapture && TERMINAL_VOID_PAYMENT_STATUSES.has(current)) {
    return {
      status: String(input.currentStatus ?? "canceled"),
      write: false,
      refusedRegression: true,
    };
  }

  // Same payment attempt: session already released / provider voided.
  // Do not block when sessionMatchesWebhookOrder === false (different attempt).
  const sameAttempt = input.sessionMatchesWebhookOrder === true;
  if (incomingPreCapture && sameAttempt) {
    const sessionReleased =
      TERMINAL_RELEASE_SESSION_STATUSES.has(norm(input.sessionStatus)) ||
      norm(input.holdReleaseState) === "released";
    const providerVoided = TERMINAL_VOID_PROVIDER_STATES.has(
      norm(input.sessionProviderState),
    );
    const tripTerminal = TERMINAL_TRIP_STATUSES.has(norm(input.tripStatus));
    const voidReason = norm(input.holdTerminalReason);
    const voidEvidence =
      voidReason.includes("void") ||
      voidReason.includes("terminal_no_fee") ||
      voidReason.includes("release");

    if (sessionReleased && (providerVoided || tripTerminal || voidEvidence)) {
      return {
        status: String(input.currentStatus ?? "canceled"),
        write: false,
        refusedRegression: true,
      };
    }
  }

  return {
    status: input.incomingStatus,
    write: true,
    refusedRegression: false,
  };
}
