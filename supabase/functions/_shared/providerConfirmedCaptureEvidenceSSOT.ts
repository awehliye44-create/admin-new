/**
 * Confirmed-capture evidence SSOT (MK-261125 payment integrity).
 *
 * trips.capture_amount_pence alone is NOT confirmation — modification fold
 * historically stamped it to the payable before any provider capture (D3/D4).
 *
 * Authoritative sources (in order):
 * 1. Provider order in COMPLETED/CAPTURED with a positive extracted amount
 * 2. Payment session in a captured terminal status with positive captured_amount
 * 3. payments row in captured/succeeded/paid with positive captured_amount
 */

const PROVIDER_CAPTURED_STATES = new Set(["COMPLETED", "CAPTURED"]);

const SESSION_CAPTURED_STATUSES = new Set([
  "captured",
  "completed",
  "capture_confirmed",
  "partial_capture_only",
]);

const PAYMENT_CAPTURED_STATUSES = new Set([
  "captured",
  "succeeded",
  "paid",
]);

function nonNeg(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

export function isProviderCaptureTerminalState(state: unknown): boolean {
  return PROVIDER_CAPTURED_STATES.has(String(state ?? "").toUpperCase());
}

export function isSessionCaptureConfirmedStatus(status: unknown): boolean {
  return SESSION_CAPTURED_STATUSES.has(String(status ?? "").toLowerCase());
}

/**
 * Resolve the confirmed capture amount from provider / session / payments
 * evidence. Never falls back to trips.capture_amount_pence.
 */
export function resolveProviderConfirmedCapturePence(args: {
  providerState?: string | null;
  providerCapturedPence?: number | null;
  sessionStatus?: string | null;
  sessionCapturedPence?: number | null;
  paymentCapturedPence?: number | null;
}): number {
  const providerState = String(args.providerState ?? "").toUpperCase();
  const providerCaptured = nonNeg(args.providerCapturedPence);
  if (PROVIDER_CAPTURED_STATES.has(providerState) && providerCaptured > 0) {
    return providerCaptured;
  }

  if (
    isSessionCaptureConfirmedStatus(args.sessionStatus) &&
    nonNeg(args.sessionCapturedPence) > 0
  ) {
    return nonNeg(args.sessionCapturedPence);
  }

  return nonNeg(args.paymentCapturedPence);
}

/**
 * Required same-order authorisation total for a fare-increasing modification.
 * Route payable (new_fare) plus accumulated waiting, preferring the preview
 * new_customer_total when present.
 */
export function resolveModificationRequiredAuthorisationPence(args: {
  newFarePence: number;
  pickupWaitingChargePence?: number | null;
  stopWaitingChargePence?: number | null;
  /** Prefer after_route_snapshot.fare_preview.new_customer_total_pence. */
  newCustomerTotalPence?: number | null;
}): number {
  const route = Math.max(0, Math.round(Number(args.newFarePence) || 0));
  const waiting =
    Math.max(0, Math.round(Number(args.pickupWaitingChargePence) || 0)) +
    Math.max(0, Math.round(Number(args.stopWaitingChargePence) || 0));
  const preview = Math.max(0, Math.round(Number(args.newCustomerTotalPence) || 0));
  return Math.max(route + waiting, preview, route);
}
