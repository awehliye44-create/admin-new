/**
 * Trip invoice snapshot display — mirrors edge writer settlement SSOT for totals.
 * Historical invoice_total_paid_pence snapshots are not recalculated on display.
 */
import {
  getTripDriverNetPence,
  getTripSettlementFarePence,
  type TripCaptureFields,
} from '@/lib/tripCaptureStatus';

export type TripInvoiceFinanceContext = {
  paymentCapturedPence?: number | null;
  ledgerTripEarningNetPence?: number | null;
};

export type TripInvoiceFinanceRow = TripCaptureFields & {
  driver_net_pence?: number | null;
};

/** Customer Paid / Final Settlement Total for future invoice generation. */
export function getTripInvoiceSettlementTotalPence(
  trip: TripInvoiceFinanceRow,
  context: TripInvoiceFinanceContext = {},
): number {
  const tripForSettlement: TripCaptureFields = {
    ...trip,
    payment_captured_pence: context.paymentCapturedPence ?? trip.payment_captured_pence,
  };
  return getTripSettlementFarePence(tripForSettlement);
}

/** Driver net for internal audit only — customer invoices do not show this. */
export function getTripInvoiceDriverNetPence(
  trip: TripInvoiceFinanceRow,
  context: TripInvoiceFinanceContext = {},
): number | null {
  const tripForNet: TripCaptureFields = {
    ...trip,
    ledger_trip_earning_net_pence: context.ledgerTripEarningNetPence ?? trip.ledger_trip_earning_net_pence,
  };
  return getTripDriverNetPence(tripForNet);
}
