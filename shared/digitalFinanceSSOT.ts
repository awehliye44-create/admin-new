/**
 * ONECAB Digital-Only Finance SSOT.
 * PLATFORM_COLLECTED service areas: new trips must never use cash.
 * DRIVER_COLLECTED_COMMISSION_WALLET: customer pays driver upfront (cash allowed).
 * Historical cash trips on digital SAs remain audit-read-only.
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

export function rejectNewCashPayment(): {
  ok: false;
  error: string;
  code: typeof CASH_PAYMENT_BLOCKED_CODE;
} {
  return { ok: false, error: CASH_PAYMENT_BLOCKED_MESSAGE, code: CASH_PAYMENT_BLOCKED_CODE };
}

/**
 * PLATFORM_COLLECTED (default): reject cash.
 * Caller must pass allowCashUpfront=true when SA is DRIVER_COLLECTED_COMMISSION_WALLET
 * (see shouldSkipPlatformPreauthForCommissionWallet).
 */
export function rejectNewCashPaymentUnlessCommissionWallet(
  allowCashUpfront: boolean,
):
  | { ok: true }
  | { ok: false; error: string; code: typeof CASH_PAYMENT_BLOCKED_CODE } {
  if (allowCashUpfront) return { ok: true };
  return rejectNewCashPayment();
}

/** Service-area payment flags for PLATFORM_COLLECTED — cash is never enabled. */
export function digitalOnlyPaymentMethodFlags(): {
  cash: false;
  card: boolean;
  wallet: boolean;
  applePay: boolean;
  googlePay: boolean;
} {
  return { cash: false, card: true, wallet: true, applePay: true, googlePay: true };
}
