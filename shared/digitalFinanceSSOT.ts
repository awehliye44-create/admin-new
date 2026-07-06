/**
 * ONECAB Digital-Only Finance SSOT.
 * ONECAB is permanently digital-only — no cash payment method exists.
 */

export const HISTORICAL_LEGACY_TRIP_LABEL = "Historical Legacy Trip";

export function normalizePaymentMethod(method: string | null | undefined): string {
  return (method ?? "").trim().toLowerCase();
}

export function historicalLegacyTripPaymentLabel(
  _paymentMethod: string | null | undefined,
): string | null {
  return null;
}

/** Digital card/wallet trips — always show Stripe capture shortfall when payable > captured. */
export function shouldShowDigitalCaptureShortfall(
  _paymentMethod: string | null | undefined,
  payablePence: number,
  capturedPence: number,
): boolean {
  if (payablePence <= 0) return false;
  return payablePence > capturedPence;
}

export function isDigitalPaymentMethod(paymentMethod: string | null | undefined): boolean {
  const m = normalizePaymentMethod(paymentMethod);
  return m.length > 0;
}

/** @deprecated Always returns false — cash is permanently removed. */
export function isHistoricalLegacyCashTrip(_paymentMethod: string | null | undefined): boolean {
  return false;
}

/** @deprecated Always returns false — cash is permanently removed. */
export function isCashPaymentMethod(_paymentMethod: string | null | undefined): boolean {
  return false;
}

/** Service-area payment flags — digital-only platform. */
export function digitalOnlyPaymentMethodFlags(): {
  card: boolean;
  wallet: boolean;
  applePay: boolean;
  googlePay: boolean;
} {
  return { card: true, wallet: true, applePay: true, googlePay: true };
}
