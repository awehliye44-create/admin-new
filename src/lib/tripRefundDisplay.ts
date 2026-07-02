import {
  computeNetPaidAfterRefund,
  resolveRefundStatus,
  type RefundStatus,
} from '../../shared/stripeRefundSSOT';

export type TripRefundFields = {
  payment_status?: string | null;
  refund_amount_pence?: number | null;
  refunded_at?: string | null;
  final_fare_pence?: number | null;
  final_customer_fare_pence?: number | null;
  capture_amount_pence?: number | null;
};

export type TripRefundDisplay = {
  refundStatus: RefundStatus;
  refundPence: number;
  customerPaidPence: number;
  netPaidPence: number;
  badgeLabel: string | null;
  paymentStatusLabel: string | null;
  showRefundBreakdown: boolean;
};

export function getTripRefundDisplay(trip: TripRefundFields): TripRefundDisplay {
  const refundPence = Math.max(0, Math.round(trip.refund_amount_pence ?? 0));
  const customerPaidPence = Math.max(
    0,
    Math.round(
      trip.final_customer_fare_pence
        ?? trip.final_fare_pence
        ?? trip.capture_amount_pence
        ?? 0,
    ),
  );
  const capturedPence = Math.max(0, Math.round(trip.capture_amount_pence ?? customerPaidPence));
  const paymentStatus = String(trip.payment_status ?? '').trim().toLowerCase();

  let refundStatus = resolveRefundStatus(capturedPence, refundPence);
  if (refundStatus === 'none' && (paymentStatus === 'refunded' || paymentStatus === 'partially_refunded')) {
    refundStatus = paymentStatus === 'partially_refunded' ? 'partially_refunded' : 'refunded';
  }

  const netPaidPence = computeNetPaidAfterRefund({
    customerPaidPence,
    refundPence,
  });

  const badgeLabel =
    refundStatus === 'refunded'
      ? 'Refunded'
      : refundStatus === 'partially_refunded'
        ? 'Partially refunded'
        : null;

  const paymentStatusLabel =
    refundStatus === 'refunded'
      ? 'Refunded'
      : refundStatus === 'partially_refunded'
        ? 'Partially refunded'
        : null;

  return {
    refundStatus,
    refundPence,
    customerPaidPence,
    netPaidPence,
    badgeLabel,
    paymentStatusLabel,
    showRefundBreakdown: refundStatus !== 'none' && refundPence > 0,
  };
}
