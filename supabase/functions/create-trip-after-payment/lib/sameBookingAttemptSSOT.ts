/**
 * MK-261105-002 — same verified booking attempt matching.
 * Webhook finalize and CTAP must converge on one trip for the same CAI / order / session.
 */

export type SameBookingTripKeys = {
  id?: string | null;
  passenger_id?: string | null;
  client_action_id?: string | null;
  provider_order_id?: string | null;
  payment_session_id?: string | null;
};

export type SameBookingAttemptArgs = {
  passengerId?: string | null;
  clientActionId?: string | null;
  providerOrderId?: string | null;
  paymentSessionId?: string | null;
};

function norm(v: string | null | undefined): string {
  return String(v ?? "").trim();
}

/** True when the existing trip is this passenger's same booking attempt. */
export function isSameVerifiedBookingAttempt(
  trip: SameBookingTripKeys,
  attempt: SameBookingAttemptArgs,
): boolean {
  const passengerId = norm(attempt.passengerId);
  const tripPassenger = norm(trip.passenger_id);
  if (passengerId && tripPassenger && passengerId !== tripPassenger) return false;

  const cai = norm(attempt.clientActionId);
  const tripCai = norm(trip.client_action_id);
  if (cai && tripCai && cai === tripCai) return true;

  const orderId = norm(attempt.providerOrderId);
  const tripOrder = norm(trip.provider_order_id);
  if (orderId && tripOrder && orderId === tripOrder) return true;

  const sessionId = norm(attempt.paymentSessionId);
  const tripSession = norm(trip.payment_session_id);
  if (sessionId && tripSession && sessionId === tripSession) return true;

  return false;
}
