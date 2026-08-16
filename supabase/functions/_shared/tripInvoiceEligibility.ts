/** Matches finalize-trip-and-capture tip window SSOT. */
export const TRIP_INVOICE_TIP_WINDOW_MS = 2 * 60 * 1000;

/** Trip still in progress — auto invoice must never run. */
const ACTIVE_TRIP_STATUSES = new Set([
  "payment_pending",
  "pending",
  "searching",
  "offered",
  "offering",
  "broadcasting",
  "negotiating",
  "driver_cancelled",
  "searching_new_driver",
  "confirmed",
  "accepted",
  "driver_assigned",
  "en_route",
  "en_route_to_pickup",
  "driver_en_route",
  "driver_arriving",
  "arrived",
  "arrived_pickup",
  "arrived_at_pickup",
  "at_pickup",
  "pickup_waiting",
  "waiting",
  "in_progress",
  "on_trip",
  "started",
  "completing",
  "queued",
]);

export type TripInvoiceEligibilityReason =
  | "already_sent"
  | "trip_still_active"
  | "trip_not_completed"
  | "tip_window_open"
  | "payment_not_finalised";

export type TripInvoiceEligibility = {
  ok: boolean;
  reason?: TripInvoiceEligibilityReason;
};

type TripInvoiceGateRow = {
  status?: string | null;
  completed_at?: string | null;
  financial_outcome?: string | null;
  payment_method?: string | null;
  payment_status?: string | null;
  provider_order_id?: string | null;
  payment_intent_id?: string | null;
  tip_window_closed_at?: string | null;
  tip_window_expires_at?: string | null;
  invoice_email_sent?: boolean | null;
};

export function isActiveTripStatusForInvoice(status: string | null | undefined): boolean {
  const normalized = (status ?? "").trim().toLowerCase();
  if (!normalized) return true;
  return ACTIVE_TRIP_STATUSES.has(normalized);
}

/** Hard rule: only terminal completed trips — never financial_outcome alone. */
export function isTripCompletedForCustomerInvoice(trip: TripInvoiceGateRow): boolean {
  const status = (trip.status ?? "").toString().trim().toLowerCase();
  if (status !== "completed") return false;
  if (!trip.completed_at) return false;
  return true;
}

export function isTipWindowClosedForInvoice(
  trip: TripInvoiceGateRow,
  nowMs = Date.now(),
): boolean {
  if (trip.tip_window_closed_at) return true;

  const expiresAt = trip.tip_window_expires_at;
  if (expiresAt && new Date(expiresAt).getTime() <= nowMs) return true;

  const completedAt = trip.completed_at;
  if (completedAt) {
    const elapsed = nowMs - new Date(completedAt).getTime();
    if (elapsed >= TRIP_INVOICE_TIP_WINDOW_MS) return true;
  }

  return false;
}

export function isPaymentFinalisedForInvoice(trip: TripInvoiceGateRow): boolean {
  const paymentMethod = (trip.payment_method ?? "").toString().trim().toLowerCase();
  const paymentStatus = (trip.payment_status ?? "").toString().trim().toLowerCase();

  if (paymentMethod === "cash") return true;
  if (["captured", "paid", "collected_cash"].includes(paymentStatus)) return true;
  if (!trip.provider_order_id && !trip.payment_intent_id && paymentStatus === "paid") return true;
  return false;
}

/** Auto customer email — completed trip only, tip window closed, payment final, once. */
export function canAutoSendCustomerInvoice(
  trip: TripInvoiceGateRow,
  nowMs = Date.now(),
): TripInvoiceEligibility {
  if (trip.invoice_email_sent) {
    return { ok: false, reason: "already_sent" };
  }

  if (isActiveTripStatusForInvoice(trip.status)) {
    return { ok: false, reason: "trip_still_active" };
  }

  if (!isTripCompletedForCustomerInvoice(trip)) {
    return { ok: false, reason: "trip_not_completed" };
  }

  if (!isTipWindowClosedForInvoice(trip, nowMs)) {
    return { ok: false, reason: "tip_window_open" };
  }

  if (!isPaymentFinalisedForInvoice(trip)) {
    return { ok: false, reason: "payment_not_finalised" };
  }

  return { ok: true };
}
