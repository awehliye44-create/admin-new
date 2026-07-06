/**
 * ONECAB Digital-Only Finance SSOT.
 * ONECAB is permanently digital-only — no cash payment method exists.
 */

export function normalizePaymentMethod(method: string | null | undefined): string {
  return (method ?? "").trim().toLowerCase();
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

/** Service-area payment flags — digital-only platform. */
export function digitalOnlyPaymentMethodFlags(): {
  card: boolean;
  wallet: boolean;
  applePay: boolean;
  googlePay: boolean;
} {
  return { card: true, wallet: true, applePay: true, googlePay: true };
}
