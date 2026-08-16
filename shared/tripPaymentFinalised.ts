/**
 * Post-trip payment finalisation SSOT — server-side capture must not depend on the
 * customer app staying open. Rating/tip UI is optional; fare capture is mandatory.
 *
 * Column mapping (no new finance SSOT columns):
 * - tip_deadline_at        → trips.tip_window_expires_at
 * - trip_payment_finalised → payment_status in captured | paid | collected_cash
 * - payment_capture_status → derivePaymentCaptureStatus()
 *
 * Fare capture is automatic at trip completion. The tip window only gates optional
 * customer tips — it does not defer fare capture.
 */

import { TIP_WINDOW_MS } from "./tipWindowConstants.ts";

export type TipWindowTrip = {
  tip_window_expires_at?: string | null;
  tip_window_closed_at?: string | null;
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

/** True while customer may still add a tip (mirrors server tipWindowPayment SSOT). */
export function isTipWindowOpen(trip: TipWindowTrip, nowMs = Date.now()): boolean {
  if (trip.tip_window_closed_at) return false;
  if (trip.tip_window_expires_at) {
    return new Date(trip.tip_window_expires_at).getTime() > nowMs;
  }
  if (trip.completed_at) {
    return nowMs - new Date(trip.completed_at).getTime() < TIP_WINDOW_MS;
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
 */
export function needsServerTipWindowFareCapture(
  trip: TripPaymentCaptureRow,
  nowMs = Date.now(),
): boolean {
  if ((trip.status ?? "").trim().toLowerCase() !== "completed") return false;
  if (isTerminalTripNoCapture(trip.status)) return false;
  if (isCashTripPaymentMethod(trip.payment_method)) return false;
  if (isTripPaymentFinalised(trip.payment_status)) return false;
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
