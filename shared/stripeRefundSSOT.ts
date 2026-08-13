/**
 * Stripe refund SSOT — pure calculations (no I/O).
 * Stripe is the source event; ONECAB persists refund state from webhook/sync/admin.
 */

export type RefundStatus = "none" | "partially_refunded" | "refunded";

export function resolveRefundStatus(
  capturedPence: number,
  refundedPence: number,
): RefundStatus {
  const captured = Math.max(0, Math.round(capturedPence));
  const refunded = Math.max(0, Math.round(refundedPence));
  if (refunded <= 0) return "none";
  if (captured > 0 && refunded >= captured) return "refunded";
  return "partially_refunded";
}

export function resolveTripPaymentStatusFromRefund(
  capturedPence: number,
  refundedPence: number,
): "refunded" | "partially_refunded" | null {
  const status = resolveRefundStatus(capturedPence, refundedPence);
  if (status === "refunded") return "refunded";
  if (status === "partially_refunded") return "partially_refunded";
  return null;
}

/** Reduce commission/driver amounts when trip has partial/full refund. */
export function applyRefundToTripAmounts(args: {
  capturedPence: number;
  refundPence: number;
  commissionPence: number;
  driverNetPence: number;
}): {
  net_captured_pence: number;
  commission_pence: number;
  driver_net_pence: number;
  commission_reversal_pence: number;
  driver_reversal_pence: number;
} {
  const captured = Math.max(0, args.capturedPence);
  const refund = Math.max(0, args.refundPence);
  const netCaptured = Math.max(0, captured - refund);
  const origCommission = Math.max(0, args.commissionPence);
  const origDriverNet = Math.max(0, args.driverNetPence);

  if (captured <= 0 || refund <= 0) {
    return {
      net_captured_pence: netCaptured,
      commission_pence: origCommission,
      driver_net_pence: origDriverNet,
      commission_reversal_pence: 0,
      driver_reversal_pence: 0,
    };
  }

  const ratio = netCaptured / captured;
  const adjustedCommission = Math.max(0, Math.round(origCommission * ratio));
  const adjustedDriverNet = Math.max(0, Math.round(origDriverNet * ratio));

  return {
    net_captured_pence: netCaptured,
    commission_pence: adjustedCommission,
    driver_net_pence: adjustedDriverNet,
    commission_reversal_pence: Math.max(0, origCommission - adjustedCommission),
    driver_reversal_pence: Math.max(0, origDriverNet - adjustedDriverNet),
  };
}

export function computeNetPaidAfterRefund(args: {
  customerPaidPence: number;
  refundPence: number;
}): number {
  return Math.max(0, Math.round(args.customerPaidPence) - Math.round(args.refundPence));
}
