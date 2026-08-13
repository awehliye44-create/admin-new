/**
 * P0 #1 — PLATFORM_COLLECTED card payment authorisation validity (pure).
 * Integer pence only. Compare authorised hold to customer payable, never floats.
 */

export type BookingFareLineage = {
  gross_fare_pence: number;
  discount_pence: number;
  customer_payable_pence: number;
};

function pence(n: unknown): number {
  const v = Math.round(Number(n ?? 0));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function readInt(obj: Record<string, unknown> | null | undefined, ...keys: string[]): number {
  if (!obj) return 0;
  for (const key of keys) {
    const v = pence(obj[key]);
    if (v > 0) return v;
  }
  return 0;
}

/**
 * Resolve gross / discount / customer-payable from payment session snapshots.
 * Prefer fare_snapshot net keys; never fall through to gross when net/discount exist.
 */
export function resolveBookingCustomerPayablePence(input: {
  bookingSnapshot?: Record<string, unknown> | null;
  fareSnapshot?: Record<string, unknown> | null;
  sessionEstimatedTotalPence?: number | null;
  sessionAuthorisedAmountPence?: number | null;
}): BookingFareLineage {
  const book = input.bookingSnapshot ?? {};
  const fare = input.fareSnapshot ?? {};

  let gross = readInt(fare, "gross_fare_pence", "original_estimated_fare_pence")
    || readInt(book, "gross_fare_pence", "original_estimated_fare_pence");

  let discount = readInt(
    fare,
    "offer_discount_pence",
    "discount_amount_pence",
  ) || readInt(
    book,
    "discount_amount_pence",
    "offer_discount_pence",
    "voucher_discount_pence",
  );

  let payable = readInt(
    fare,
    "final_fare_pence",
    "estimated_total_pence",
    "authorised_amount_pence",
    "final_estimated_fare_pence",
  ) || readInt(
    book,
    "final_estimated_fare_pence",
    "final_fare_pence",
    "estimated_total_pence",
    "final_payable_pence",
    "authorised_amount_pence",
  ) || pence(input.sessionEstimatedTotalPence)
    || pence(input.sessionAuthorisedAmountPence);

  if (payable === gross && gross > 0 && discount > 0) {
    payable = readInt(fare, "final_fare_pence", "estimated_total_pence")
      || readInt(book, "final_estimated_fare_pence")
      || pence(input.sessionEstimatedTotalPence)
      || pence(input.sessionAuthorisedAmountPence)
      || Math.max(0, gross - discount);
  }

  if (gross <= 0 && payable > 0) gross = payable + discount;
  if (discount <= 0 && gross > 0 && payable > 0 && payable < gross) {
    discount = gross - payable;
  }

  return {
    gross_fare_pence: Math.max(0, gross),
    discount_pence: Math.max(0, discount),
    customer_payable_pence: Math.max(0, payable),
  };
}

export type PaymentAuthorisationValidityInput = {
  paymentMethod?: string | null;
  providerState?: string | null;
  sessionStatus?: string | null;
  authorisedAmountPence?: number | null;
  totalAuthorisedAmountPence?: number | null;
  requiredCustomerPayablePence?: number | null;
  releasedAt?: string | null;
  capturedAt?: string | null;
};

export type PaymentAuthorisationValidity = {
  valid: boolean;
  code: string | null;
  authorised_amount_pence: number;
  required_amount_pence: number;
};

const CARD_METHODS = new Set(["CARD", "APPLE_PAY", "GOOGLE_PAY"]);
const USABLE_PROVIDER = new Set(["AUTHORISED", "AUTHORIZED", "COMPLETED"]);
const BAD_SESSION = new Set([
  "cancelled",
  "failed",
  "payment_orphaned",
  "orphan_authorisation",
  "released",
  "RECOVERY_CANCELLED",
  "RECOVERY_DECLINED",
  "RECOVERY_EXPIRED",
]);

export function evaluatePaymentAuthorisationValidity(
  input: PaymentAuthorisationValidityInput,
): PaymentAuthorisationValidity {
  const method = String(input.paymentMethod ?? "").trim().toUpperCase();
  if (!CARD_METHODS.has(method)) {
    return { valid: true, code: null, authorised_amount_pence: 0, required_amount_pence: 0 };
  }

  const authorised = Math.max(
    0,
    pence(input.totalAuthorisedAmountPence) || pence(input.authorisedAmountPence),
  );
  const required = pence(input.requiredCustomerPayablePence);

  if (input.releasedAt && !input.capturedAt) {
    return {
      valid: false,
      code: "PAYMENT_GATE_NOT_SATISFIED",
      authorised_amount_pence: authorised,
      required_amount_pence: required,
    };
  }

  const status = String(input.sessionStatus ?? "");
  if (BAD_SESSION.has(status) || BAD_SESSION.has(status.toLowerCase())) {
    return {
      valid: false,
      code: "PAYMENT_GATE_NOT_SATISFIED",
      authorised_amount_pence: authorised,
      required_amount_pence: required,
    };
  }

  const provider = String(input.providerState ?? "").trim().toUpperCase();
  if (!USABLE_PROVIDER.has(provider)) {
    return {
      valid: false,
      code: "PAYMENT_GATE_NOT_SATISFIED",
      authorised_amount_pence: authorised,
      required_amount_pence: required,
    };
  }

  if (authorised <= 0 || required <= 0) {
    return {
      valid: false,
      code: "PAYMENT_GATE_NOT_SATISFIED",
      authorised_amount_pence: authorised,
      required_amount_pence: required,
    };
  }

  if (authorised < required) {
    return {
      valid: false,
      code: "PAYMENT_AUTHORISATION_INSUFFICIENT",
      authorised_amount_pence: authorised,
      required_amount_pence: required,
    };
  }

  return {
    valid: true,
    code: null,
    authorised_amount_pence: authorised,
    required_amount_pence: required,
  };
}
