/**
 * Settlement finance SSOT helpers for edge functions and reconciliation audit rows.
 * Mirrors src/lib/tripCaptureStatus.ts — keep display logic aligned.
 */

export type TripSettlementFields = {
  payment_method?: string | null;
  payment_status?: string | null;
  final_fare_pence?: number | null;
  gross_fare_pence?: number | null;
  capture_amount_pence?: number | null;
  final_customer_fare_pence?: number | null;
};

export type PaymentCaptureFields = {
  captured_amount_pence?: number | null;
  amount_pence?: number | null;
  status?: string | null;
};

export type LedgerEarningFields = {
  type: string;
  amount_pence: number;
};

const CARD_METHODS = new Set(["card", "apple_pay", "google_pay"]);

export function isCardTrip(trip: { payment_method?: string | null }): boolean {
  const method = (trip.payment_method ?? "").toLowerCase();
  return CARD_METHODS.has(method);
}

export function getPaymentRowCapturedPence(payment: PaymentCaptureFields): number {
  if (payment.captured_amount_pence != null && payment.captured_amount_pence > 0) {
    return payment.captured_amount_pence;
  }
  const status = (payment.status ?? "").toLowerCase();
  if (status === "captured" && payment.amount_pence != null && payment.amount_pence > 0) {
    return payment.amount_pence;
  }
  return 0;
}

export function sumPaymentsCapturedPence(payments: PaymentCaptureFields[]): number {
  let sum = 0;
  for (const payment of payments) {
    sum += getPaymentRowCapturedPence(payment);
  }
  return sum;
}

function isCardPaymentCaptured(
  trip: TripSettlementFields,
  paymentCapturedPence: number | null | undefined,
): boolean {
  if (!isCardTrip(trip)) return false;
  const captured = paymentCapturedPence ?? (trip.capture_amount_pence ?? 0);
  if (captured <= 0) return false;
  const status = (trip.payment_status ?? "").toLowerCase();
  return status === "captured" || status === "paid" || captured > 0;
}

/**
 * Settlement / customer-paid fare for admin finance displays.
 * Card captured: payments.captured_amount_pence wins.
 * Cash collected: final_fare_pence.
 */
export function getTripSettlementFarePence(
  trip: TripSettlementFields,
  args?: { paymentCapturedPence?: number | null },
): number {
  const paymentCaptured = args?.paymentCapturedPence ?? null;

  if (isCardPaymentCaptured(trip, paymentCaptured)) {
    return paymentCaptured != null && paymentCaptured > 0
      ? paymentCaptured
      : Math.max(0, trip.capture_amount_pence ?? 0);
  }

  if (!isCardTrip(trip)) {
    const status = (trip.payment_status ?? "").toLowerCase();
    if (status === "collected_cash") {
      if (trip.final_fare_pence != null && trip.final_fare_pence > 0) {
        return trip.final_fare_pence;
      }
      if (paymentCaptured != null && paymentCaptured > 0) return paymentCaptured;
      if (trip.capture_amount_pence != null && trip.capture_amount_pence > 0) {
        return trip.capture_amount_pence;
      }
    }
  }

  if (trip.final_fare_pence != null) {
    return Math.max(0, trip.final_fare_pence);
  }

  if (trip.gross_fare_pence != null && trip.gross_fare_pence > 0) {
    return trip.gross_fare_pence;
  }

  if (paymentCaptured != null && paymentCaptured > 0) return paymentCaptured;
  if (trip.capture_amount_pence != null && trip.capture_amount_pence > 0) {
    return trip.capture_amount_pence;
  }

  return 0;
}

/** Ledger TRIP_EARNING_NET first, then trips.driver_net_pence. Never fare − commission. */
export function getTripDriverNetPence(args: {
  driver_net_pence?: number | null;
  ledger?: LedgerEarningFields[];
}): number | null {
  const ledger = args.ledger ?? [];
  const earning = ledger.find((entry) => entry.type === "TRIP_EARNING_NET");
  if (earning != null && earning.amount_pence >= 0) {
    return earning.amount_pence;
  }
  if (args.driver_net_pence != null) {
    return Math.max(0, args.driver_net_pence);
  }
  return null;
}

/** Captured amount for audit — payments.captured_amount_pence primary, trips.capture_amount_pence fallback. */
export function getTripCapturedPenceForAudit(args: {
  paymentCapturedPence?: number | null;
  tripCaptureAmountPence?: number | null;
}): number {
  if (args.paymentCapturedPence != null && args.paymentCapturedPence > 0) {
    return args.paymentCapturedPence;
  }
  return Math.max(0, args.tripCaptureAmountPence ?? 0);
}
