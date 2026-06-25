/**
 * Synced from drive-hub-buddy — run scripts/sync-finance-ssot.ts to refresh.
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
const CAPTURED_PAYMENT_STATUSES = new Set(["captured", "paid", "succeeded"]);
const CASH_COLLECTED_STATUSES = new Set(["collected_cash", "cash_collected"]);

export function isCardTrip(trip: { payment_method?: string | null }): boolean {
  const method = (trip.payment_method ?? "").toLowerCase();
  return CARD_METHODS.has(method);
}

export function isCashTrip(trip: { payment_method?: string | null }): boolean {
  return String(trip.payment_method ?? "").trim().toLowerCase() === "cash";
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
  const status = (trip.payment_status ?? "").toLowerCase();
  if (CAPTURED_PAYMENT_STATUSES.has(status)) return true;
  const captured = paymentCapturedPence ?? (trip.capture_amount_pence ?? 0);
  return captured > 0;
}

/** Settlement / customer-paid total for finance displays. */
export function getTripSettlementFarePence(
  trip: TripSettlementFields,
  args?: { paymentCapturedPence?: number | null },
): number {
  const paymentCaptured = args?.paymentCapturedPence ?? null;

  if (isCardPaymentCaptured(trip, paymentCaptured)) {
    if (paymentCaptured != null && paymentCaptured > 0) return paymentCaptured;
    if (trip.capture_amount_pence != null && trip.capture_amount_pence > 0) {
      return trip.capture_amount_pence;
    }
    if (trip.final_fare_pence != null && trip.final_fare_pence > 0) {
      return trip.final_fare_pence;
    }
    return 0;
  }

  if (!isCardTrip(trip)) {
    const status = (trip.payment_status ?? "").toLowerCase();
    if (CASH_COLLECTED_STATUSES.has(status)) {
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

/** Cash commission debt recovered from card earnings on this trip (DEBT_RECOVERY ledger abs sum). */
export function getTripDebtRecoveredPence(ledger: LedgerEarningFields[] = []): number {
  let total = 0;
  for (const entry of ledger) {
    if (entry.type === "DEBT_RECOVERY") {
      total += Math.abs(entry.amount_pence);
    }
  }
  return total;
}

/** Driver net credited to wallet minus cash-commission debt recovered on capture. */
export function getTripAvailablePayoutCreatedPence(args: {
  driverNetPence: number | null;
  debtRecoveredPence: number;
}): number | null {
  if (args.driverNetPence == null) return null;
  return Math.max(0, args.driverNetPence - args.debtRecoveredPence);
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

export function customerPaidLabel(trip: { payment_method?: string | null }): "Customer Paid" | "Cash Collected" {
  return isCashTrip(trip) ? "Cash Collected" : "Customer Paid";
}

/** Completed-trip payment status badge — not ambiguous "card" alone. */
export function completedTripPaymentStatusLabel(trip: {
  payment_method?: string | null;
  payment_status?: string | null;
}): string | null {
  const status = String(trip.payment_status ?? "").trim().toLowerCase();
  if (isCashTrip(trip) && CASH_COLLECTED_STATUSES.has(status)) {
    return "Cash Collected";
  }
  if (isCardTrip(trip) && CAPTURED_PAYMENT_STATUSES.has(status)) {
    return "Card Captured";
  }
  return null;
}
