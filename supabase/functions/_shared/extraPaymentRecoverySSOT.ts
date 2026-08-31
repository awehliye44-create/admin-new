/**
 * Server-side extra payment / capture mismatch recovery — Financial Reconciliation SSOT.
 * Never trust UI amount_pence; derive charge from settlement vs captured + trip.outstanding_balance_pence.
 */
import {
  getPaymentRowCapturedPence,
  sumPaymentsCapturedPence,
  type PaymentCaptureFields,
} from "./tripSettlementFinanceSSOT.ts";

export const EXTRA_PAYMENT_TOLERANCE_PENCE = 1;

export type ExtraPaymentTripFields = {
  final_fare_pence?: number | null;
  tip_pence?: number | null;
  tip_amount_pence?: number | null;
  arrival_cancellation_applied?: boolean | null;
  arrival_cancellation_fee?: number | null;
  outstanding_balance_pence?: number | null;
  capture_amount_pence?: number | null;
};

export function getTripTipPenceServer(trip: ExtraPaymentTripFields): number {
  return Math.max(0, trip.tip_pence ?? trip.tip_amount_pence ?? 0);
}

/** Settlement total the customer owes (fare + tip + trip-level lifecycle extras). */
export function computeSettlementTotalPence(trip: ExtraPaymentTripFields): number {
  const fare = Math.max(0, trip.final_fare_pence ?? 0);
  const tip = getTripTipPenceServer(trip);
  const extras =
    trip.arrival_cancellation_applied === true && trip.arrival_cancellation_fee != null
      ? Math.max(0, trip.arrival_cancellation_fee)
      : 0;
  return fare + tip + extras;
}

export type CustomerPayableTripFields = ExtraPaymentTripFields & {
  final_customer_fare_pence?: number | null;
  gross_fare_pence?: number | null;
  discount_pence?: number | null;
  offer_discount_pence?: number | null;
  total_waiting_charge_pence?: number | null;
  pickup_waiting_charge_pence?: number | null;
};

/**
 * Post-discount customer payable for outstanding / shortfall — never treat promo/discount gap as shortfall.
 */
export function resolveCustomerPayablePenceForAudit(args: {
  trip: CustomerPayableTripFields;
  settlementTotalPence: number;
  capturedPence?: number | null;
}): number {
  const tip = getTripTipPenceServer(args.trip);
  const waiting = Math.max(
    0,
    args.trip.total_waiting_charge_pence ?? args.trip.pickup_waiting_charge_pence ?? 0,
  );
  const finalCustomer = Math.max(0, args.trip.final_customer_fare_pence ?? 0);
  const finalFare = Math.max(0, args.trip.final_fare_pence ?? 0);
  const gross = Math.max(0, args.trip.gross_fare_pence ?? 0);
  const explicitDiscount = Math.max(
    0,
    args.trip.discount_pence ?? 0,
    args.trip.offer_discount_pence ?? 0,
    gross > finalFare && finalFare > 0 ? gross - finalFare : 0,
  );
  const captured = args.capturedPence != null && args.capturedPence > 0
    ? Math.round(args.capturedPence)
    : null;

  if (finalCustomer > 0) {
    const fromCustomer = finalCustomer + waiting + tip;
    if (captured != null && Math.abs(captured - fromCustomer) <= EXTRA_PAYMENT_TOLERANCE_PENCE) {
      return fromCustomer;
    }
    if (fromCustomer < args.settlementTotalPence - EXTRA_PAYMENT_TOLERANCE_PENCE) {
      return fromCustomer;
    }
  }

  if (explicitDiscount > 0) {
    const postDiscountSettlement = Math.max(0, args.settlementTotalPence - explicitDiscount);
    if (finalFare > 0) {
      const fromFinalFare = finalFare + waiting + tip;
      if (captured != null && captured >= fromFinalFare - EXTRA_PAYMENT_TOLERANCE_PENCE) {
        return fromFinalFare;
      }
      return fromFinalFare;
    }
    if (captured != null && captured >= postDiscountSettlement - EXTRA_PAYMENT_TOLERANCE_PENCE) {
      return Math.max(captured, postDiscountSettlement);
    }
  }

  if (
    captured != null
    && captured < args.settlementTotalPence - EXTRA_PAYMENT_TOLERANCE_PENCE
    && explicitDiscount > 0
    && Math.abs(args.settlementTotalPence - captured - explicitDiscount) <= EXTRA_PAYMENT_TOLERANCE_PENCE
  ) {
    return captured;
  }

  return args.settlementTotalPence;
}

export function sumTripPaymentsCapturedPence(payments: PaymentCaptureFields[]): number {
  return sumPaymentsCapturedPence(payments);
}

export type ExtraPaymentChargeResolution = {
  charge_pence: number;
  settlement_total_pence: number;
  captured_total_pence: number;
  computed_outstanding_pence: number;
  stored_outstanding_pence: number;
  source: "trip_outstanding_ssot" | "settlement_minus_captured" | "none";
};

/**
 * Resolve delta to charge. Prefers trips.outstanding_balance_pence when aligned with settlement − captured.
 */
export function resolveExtraPaymentChargePence(args: {
  trip: ExtraPaymentTripFields;
  payments: PaymentCaptureFields[];
}): ExtraPaymentChargeResolution {
  const settlement_total_pence = computeSettlementTotalPence(args.trip);
  const captured_total_pence = sumTripPaymentsCapturedPence(args.payments);
  const computed_outstanding_pence = Math.max(0, settlement_total_pence - captured_total_pence);
  const stored_outstanding_pence = Math.max(0, Number(args.trip.outstanding_balance_pence ?? 0));

  if (
    stored_outstanding_pence > 0 &&
    Math.abs(stored_outstanding_pence - computed_outstanding_pence) <= EXTRA_PAYMENT_TOLERANCE_PENCE
  ) {
    return {
      charge_pence: stored_outstanding_pence,
      settlement_total_pence,
      captured_total_pence,
      computed_outstanding_pence,
      stored_outstanding_pence,
      source: "trip_outstanding_ssot",
    };
  }

  if (computed_outstanding_pence > 0) {
    return {
      charge_pence: computed_outstanding_pence,
      settlement_total_pence,
      captured_total_pence,
      computed_outstanding_pence,
      stored_outstanding_pence,
      source: "settlement_minus_captured",
    };
  }

  if (stored_outstanding_pence > 0) {
    return {
      charge_pence: stored_outstanding_pence,
      settlement_total_pence,
      captured_total_pence,
      computed_outstanding_pence,
      stored_outstanding_pence,
      source: "trip_outstanding_ssot",
    };
  }

  return {
    charge_pence: 0,
    settlement_total_pence,
    captured_total_pence,
    computed_outstanding_pence,
    stored_outstanding_pence,
    source: "none",
  };
}

export function assertExtraPaymentAmountTrusted(
  requestedPence: number | undefined,
  chargePence: number,
): string | null {
  if (requestedPence == null) return null;
  if (Math.abs(requestedPence - chargePence) > EXTRA_PAYMENT_TOLERANCE_PENCE) {
    return `amount_pence (${requestedPence}) does not match server outstanding (${chargePence})`;
  }
  return null;
}
