/**
 * ONECAB Digital-Only Finance SSOT.
 * New trips must never use cash. Historical cash trips are audit-read-only.
 */

export const HISTORICAL_LEGACY_TRIP_LABEL = "Historical Legacy Trip";

export const CASH_PAYMENT_BLOCKED_MESSAGE =
  "Cash payment is no longer supported. ONECAB is a digital-only platform.";

export const CASH_PAYMENT_BLOCKED_CODE = "CASH_NOT_SUPPORTED";

export function normalizePaymentMethod(method: string | null | undefined): string {
  return (method ?? "").trim().toLowerCase();
}

/** Historical trip booked before digital-only era — display only, no finance actions. */
export function isHistoricalLegacyCashTrip(paymentMethod: string | null | undefined): boolean {
  return normalizePaymentMethod(paymentMethod) === "cash";
}

/** @deprecated Alias — use isHistoricalLegacyCashTrip for audit/historical rows only. */
export function isCashPaymentMethod(paymentMethod: string | null | undefined): boolean {
  return isHistoricalLegacyCashTrip(paymentMethod);
}

export function historicalLegacyTripPaymentLabel(
  paymentMethod: string | null | undefined,
): string | null {
  return isHistoricalLegacyCashTrip(paymentMethod) ? HISTORICAL_LEGACY_TRIP_LABEL : null;
}

/** Digital card/wallet trips only — legacy cash must never show Stripe capture shortfall. */
export function shouldShowDigitalCaptureShortfall(
  paymentMethod: string | null | undefined,
  payablePence: number,
  capturedPence: number,
): boolean {
  if (isHistoricalLegacyCashTrip(paymentMethod)) return false;
  if (payablePence <= 0) return false;
  return payablePence > capturedPence;
}

export function isDigitalPaymentMethod(paymentMethod: string | null | undefined): boolean {
  const m = normalizePaymentMethod(paymentMethod);
  return m.length > 0 && m !== "cash";
}

export function rejectNewCashPayment(): {
  ok: false;
  error: string;
  code: typeof CASH_PAYMENT_BLOCKED_CODE;
} {
  return { ok: false, error: CASH_PAYMENT_BLOCKED_MESSAGE, code: CASH_PAYMENT_BLOCKED_CODE };
}

/** Service-area payment flags — cash is never enabled on a digital-only platform. */
export function digitalOnlyPaymentMethodFlags(): {
  cash: false;
  card: boolean;
  wallet: boolean;
  applePay: boolean;
  googlePay: boolean;
} {
  return { cash: false, card: true, wallet: true, applePay: true, googlePay: true };
}
