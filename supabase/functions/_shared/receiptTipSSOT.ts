/**
 * Receipt tip line must use the same confirmed capture as the paid total.
 * Prefer payments.captured_amount_pence. Fall back to trips.capture_amount_pence
 * only when no payment row has a captured amount. A hold-sized trip stamp must
 * not print a tip the payments table did not collect.
 */
import { invoiceTipPenceFromConfirmedCapture } from "../../../shared/tripPaymentFinalised.ts";
import {
  sumPaymentsCapturedPence,
  type PaymentCaptureFields,
} from "./tripSettlementFinanceSSOT.ts";

export function receiptCapturePence(
  trip: { capture_amount_pence?: number | null },
  payments: PaymentCaptureFields[] = [],
): number {
  const paymentCaptured = payments.length > 0 ? sumPaymentsCapturedPence(payments) : 0;
  if (paymentCaptured > 0) return paymentCaptured;
  return Math.max(0, Math.round(Number(trip.capture_amount_pence) || 0));
}

export function receiptTipPence(
  trip: {
    payment_method?: string | null;
    capture_amount_pence?: number | null;
    final_fare_pence?: number | null;
    tip_pence?: number | null;
    tip_amount_pence?: number | null;
  },
  payments: PaymentCaptureFields[] = [],
): number {
  return invoiceTipPenceFromConfirmedCapture({
    paymentMethod: trip.payment_method,
    captureAmountPence: receiptCapturePence(trip, payments),
    finalFarePence: trip.final_fare_pence,
    requestedTipPence: Number(trip.tip_pence ?? trip.tip_amount_pence ?? 0),
  });
}
