/**
 * Post-trip payment finalisation SSOT — server-side capture must not depend on the
 * customer app staying open. Rating/tip UI is optional; fare capture is mandatory.
 *
 * Column mapping (no new finance SSOT columns beyond tip window stamps):
 * - tip_deadline_at        → trips.tip_window_expires_at
 * - tip_window_opened_at   → stamped at complete when tip window deferral applies
 * - tip_window_status      → open | closed
 * - trip_payment_finalised → payment_status in captured | paid | collected_cash
 * - payment_capture_status → derivePaymentCaptureStatus()
 *
 * Tip-eligible Customer App card trips (tips_enabled): fare capture is deferred
 * until tip submit / tip=0 / skip / tip-window expiry (TIP_WINDOW_MS from completed_at).
 * All other channels capture immediately at trip completion.
 */

export type TipWindowTrip = {
  tip_window_expires_at?: string | null;
  tip_window_closed_at?: string | null;
  tip_window_status?: string | null;
  completed_at?: string | null;
};

export type TripPaymentCaptureRow = TipWindowTrip & {
  id?: string;
  status?: string | null;
  payment_method?: string | null;
  payment_status?: string | null;
  payment_intent_id?: string | null;
  provider_order_id?: string | null;
};

export type PaymentCaptureStatus =
  | "pending_tip_window"
  | "capture_scheduled"
  | "capturing"
  | "captured"
  | "failed"
  | "requires_review"
  | "not_required";

const FINALISED_PAYMENT_STATUSES = new Set([
  "captured",
  "paid",
  "collected_cash",
]);

const TERMINAL_NO_CAPTURE_STATUSES = new Set([
  "cancelled",
  "expired",
  "no_show",
  "rejected",
]);

/**
 * True only while a backend-stamped tip window is still open.
 * Never invent an open window from completed_at alone — that blocked
 * sweep/finalize for 20 minutes on non-deferred (immediate-capture) trips.
 */
export function isTipWindowOpen(trip: TipWindowTrip, nowMs = Date.now()): boolean {
  if (trip.tip_window_closed_at) return false;
  if (trip.tip_window_expires_at) {
    return new Date(trip.tip_window_expires_at).getTime() > nowMs;
  }
  return false;
}

export function isCashTripPaymentMethod(paymentMethod: string | null | undefined): boolean {
  return (paymentMethod ?? "").trim().toLowerCase() === "cash";
}

/** trips.trip_payment_finalised equivalent — fare captured or cash collected. */
export function isTripPaymentFinalised(paymentStatus: string | null | undefined): boolean {
  return FINALISED_PAYMENT_STATUSES.has((paymentStatus ?? "").trim().toLowerCase());
}

export function isTerminalTripNoCapture(status: string | null | undefined): boolean {
  return TERMINAL_NO_CAPTURE_STATUSES.has((status ?? "").trim().toLowerCase());
}

/**
 * Server cron / edge job: capture fare-only after tip window closes when the
 * passenger app may be backgrounded, killed, or offline.
 * Only trips that actually opened a tip window (expires_at stamped).
 */
export function needsServerTipWindowFareCapture(
  trip: TripPaymentCaptureRow,
  nowMs = Date.now(),
): boolean {
  if ((trip.status ?? "").trim().toLowerCase() !== "completed") return false;
  if (isTerminalTripNoCapture(trip.status)) return false;
  if (isCashTripPaymentMethod(trip.payment_method)) return false;
  if (isTripPaymentFinalised(trip.payment_status)) return false;
  if (!trip.tip_window_expires_at) return false;
  const providerPaymentId = String(
    trip.payment_intent_id ?? trip.provider_order_id ?? "",
  ).trim();
  if (!providerPaymentId) return false;
  if (isTipWindowOpen(trip, nowMs)) return false;
  return true;
}

export function derivePaymentCaptureStatus(
  trip: TripPaymentCaptureRow,
  nowMs = Date.now(),
): PaymentCaptureStatus {
  const status = (trip.status ?? "").trim().toLowerCase();
  if (status !== "completed") return "not_required";
  if (isTerminalTripNoCapture(status)) return "not_required";

  if (isCashTripPaymentMethod(trip.payment_method)) {
    return isTripPaymentFinalised(trip.payment_status) ? "captured" : "pending_tip_window";
  }

  if (isTripPaymentFinalised(trip.payment_status)) return "captured";

  const paymentStatus = (trip.payment_status ?? "").trim().toLowerCase();
  if (paymentStatus === "capture_failed") return "failed";

  if (isTipWindowOpen(trip, nowMs)) return "pending_tip_window";
  if (needsServerTipWindowFareCapture(trip, nowMs)) return "capture_scheduled";

  return "requires_review";
}

/** Idempotency key prefix for final fare capture per trip (provider + ledger). */
export function buildFinalFareCaptureIdempotencyKey(tripId: string): string {
  return `final_fare_capture_${tripId}`;
}

/**
 * Tip already paid on a completed Revolut order.
 * Credit DRIVER_TIP_CREDIT only when the confirmed capture covers fare + requested tip.
 * A fare-only capture must not invent a tip credit.
 */
export function tipCollectedFromConfirmedCapture(args: {
  captureAmountPence: number;
  farePlusTipPence: number;
  requestedTipPence: number;
}): { tipCollectedPence: number; tipShortfallPence: number } {
  const tip = Math.max(0, Math.round(Number(args.requestedTipPence) || 0));
  const farePlusTip = Math.max(0, Math.round(Number(args.farePlusTipPence) || 0));
  const captured = Math.max(0, Math.round(Number(args.captureAmountPence) || 0));
  if (tip === 0) return { tipCollectedPence: 0, tipShortfallPence: 0 };
  if (captured + 1 >= farePlusTip) {
    return { tipCollectedPence: tip, tipShortfallPence: 0 };
  }
  return { tipCollectedPence: 0, tipShortfallPence: tip };
}

/**
 * Customer invoice / repair / recovery credit.
 * Card: only the tip covered by confirmed capture (final_fare excludes tip).
 * Cash: the recorded tip — there is no platform capture to prove it.
 */
export function invoiceTipPenceFromConfirmedCapture(args: {
  paymentMethod?: string | null;
  captureAmountPence?: number | null;
  finalFarePence?: number | null;
  requestedTipPence?: number | null;
}): number {
  const requested = Math.max(0, Math.round(Number(args.requestedTipPence) || 0));
  if (requested === 0) return 0;
  if (isCashTripPaymentMethod(args.paymentMethod)) return requested;
  const captured = Math.max(0, Math.round(Number(args.captureAmountPence) || 0));
  const fare = Math.max(0, Math.round(Number(args.finalFarePence) || 0));
  if (captured <= 0 || fare <= 0) return 0;
  return tipCollectedFromConfirmedCapture({
    captureAmountPence: captured,
    farePlusTipPence: fare + requested,
    requestedTipPence: requested,
  }).tipCollectedPence;
}

/**
 * Expiry capture is fare-only. A stale or unreverted tip claim is ignored.
 * Only a customer Submit before expiry may capture fare + tip.
 */
export function expiryFareOnlyTipPence(_claimedTipPence?: unknown): 0 {
  return 0;
}

/**
 * Already-captured expiry close. Do not POST again and do not invent a tip.
 * A leftover claim is cleared unless a before-expiry capture already settled
 * that tip (existing DRIVER_TIP_CREDIT) and the stored capture covers it.
 */
export function visibleTipAfterExpiredWindowClose(args: {
  requestedTipPence: number;
  priorSettledTipPence: number;
  captureAmountPence: number;
  farePence: number;
}): number {
  const requested = Math.max(0, Math.round(Number(args.requestedTipPence) || 0));
  const settled = Math.max(0, Math.round(Number(args.priorSettledTipPence) || 0));
  if (requested === 0 || settled <= 0) return 0;
  const keep = Math.min(requested, settled);
  const covered = tipCollectedFromConfirmedCapture({
    captureAmountPence: args.captureAmountPence,
    farePlusTipPence: Math.max(0, Math.round(Number(args.farePence) || 0)) + keep,
    requestedTipPence: keep,
  });
  return covered.tipCollectedPence === keep ? keep : 0;
}

/** Stamped window has passed and has not been closed. Capture must be fare-only. */
export function expiredUnclosedTipWindowForbidsTipCapture(
  trip: TipWindowTrip,
  nowMs = Date.now(),
): boolean {
  if (!trip.tip_window_expires_at || trip.tip_window_closed_at) return false;
  return !isTipWindowOpen(trip, nowMs);
}

/**
 * Tip still paid after a refund. A refund that stays within the fare does not
 * un-collect a covered tip. Only the portion of the refund above the fare
 * reduces the tip, matching the DRIVER_TIP_CREDIT claw.
 */
export function tipPenceRemainingAfterRefund(args: {
  paymentMethod?: string | null;
  grossCapturePence?: number | null;
  finalFarePence?: number | null;
  requestedTipPence?: number | null;
  refundedPence?: number | null;
}): number {
  const fare = Math.max(0, Math.round(Number(args.finalFarePence) || 0));
  const refunded = Math.max(0, Math.round(Number(args.refundedPence) || 0));
  const collected = invoiceTipPenceFromConfirmedCapture({
    paymentMethod: args.paymentMethod,
    captureAmountPence: args.grossCapturePence,
    finalFarePence: fare,
    requestedTipPence: args.requestedTipPence,
  });
  if (collected <= 0 || refunded <= fare) return collected;
  return Math.max(0, collected - (refunded - fare));
}

/**
 * Tip to persist from a capture response.
 * A missing collected amount is not the requested tip — callers must not
 * fall back with `?? tipPence` (that records an unpaid claim).
 * Returns null only when the field is absent so a caller can fail closed to 0.
 */
export function recordedTipPenceAfterCapture(collected: unknown): number | null {
  if (collected == null || collected === "") return null;
  const n = Math.round(Number(collected));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Close a tip window only after a confirmed positive capture.
 * invokeFinalizeTripCapture treats shortfall / recovery / processing as ok so
 * callers do not stamp capture_failed. That must not seal the window — an
 * uncaptured fare would never be retried.
 */
export function tipWindowCloseAllowedAfterFinalize(
  body: Record<string, unknown> | null | undefined,
): boolean {
  const captured = Number(body?.capture_amount_pence ?? body?.captureAmountPence);
  return Number.isFinite(captured) && captured > 0;
}

/**
 * Close-only path: a captured/paid status is not proof. Card rows need a
 * positive stored capture. Cash has no platform capture to prove.
 */
export function storedCaptureAllowsTipWindowClose(args: {
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  captureAmountPence?: number | null;
}): boolean {
  const status = String(args.paymentStatus ?? "").trim().toLowerCase();
  if (isCashTripPaymentMethod(args.paymentMethod) || status === "collected_cash") return true;
  return Math.round(Number(args.captureAmountPence) || 0) > 0;
}
