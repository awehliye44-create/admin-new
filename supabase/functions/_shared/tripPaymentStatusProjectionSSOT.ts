/**
 * #108 — trips.payment_status must not regress after a provider-confirmed capture.
 *
 * MK-261126-005 / MK-261125-009: a late Revolut ORDER_AUTHORISED webhook wrote
 * payment_status=authorized after ORDER_COMPLETED had already set captured.
 * payment_hold_status and capture_amount_pence stayed captured, so the trip
 * row split. This predicate is the edge guard. The database trigger
 * trips_refuse_regressive_payment_status is the writer backstop.
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

  return {
    status: input.incomingStatus,
    write: true,
    refusedRegression: false,
  };
}
