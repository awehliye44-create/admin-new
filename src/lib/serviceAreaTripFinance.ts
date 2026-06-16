import {
  getPaymentRowCapturedPence,
  getTripDriverNetPence,
  getTripSettlementFarePence,
  type TripCaptureFields,
} from '@/lib/tripCaptureStatus';

export type ServiceAreaTripFinanceRow = {
  payment_method?: string | null;
  payment_status?: string | null;
  final_fare_pence?: number | null;
  gross_fare_pence?: number | null;
  capture_amount_pence?: number | null;
  driver_net_pence?: number | null;
};

export type ServiceAreaTripFinanceContext = {
  paymentCapturedPence?: number | null;
  ledgerTripEarningNetPence?: number | null;
};

export function sumPaymentCapturedPenceForTrip(
  payments: Array<{
    captured_amount_pence?: number | null;
    amount_pence?: number | null;
    status?: string | null;
  }>,
): number {
  return payments.reduce((sum, payment) => sum + getPaymentRowCapturedPence(payment), 0);
}

export function toServiceAreaTripCaptureFields(
  trip: ServiceAreaTripFinanceRow,
  context: ServiceAreaTripFinanceContext = {},
): TripCaptureFields {
  const paymentCaptured = context.paymentCapturedPence ?? 0;
  return {
    payment_method: trip.payment_method,
    payment_status: trip.payment_status,
    final_fare_pence: trip.final_fare_pence,
    gross_fare_pence: trip.gross_fare_pence,
    capture_amount_pence: trip.capture_amount_pence,
    driver_net_pence: trip.driver_net_pence,
    payment_captured_pence: paymentCaptured > 0 ? paymentCaptured : null,
    ledger_trip_earning_net_pence: context.ledgerTripEarningNetPence ?? null,
  };
}

export function getServiceAreaTripCustomerPaidPence(
  trip: ServiceAreaTripFinanceRow,
  context: ServiceAreaTripFinanceContext = {},
): number {
  return getTripSettlementFarePence(toServiceAreaTripCaptureFields(trip, context));
}

export function getServiceAreaTripDriverNetPence(
  trip: ServiceAreaTripFinanceRow,
  context: ServiceAreaTripFinanceContext = {},
): number | null {
  return getTripDriverNetPence(toServiceAreaTripCaptureFields(trip, context));
}
