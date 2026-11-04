/**
 * Pure copy + eligibility helpers for customer refund confirmation messages.
 * I/O lives in customerRefundNotify.ts.
 */

export type RefundNotifyChannel = "push" | "email" | "sms";

export const REFUND_NOTIFY_CHANNELS: readonly RefundNotifyChannel[] = [
  "push",
  "email",
  "sms",
] as const;

/** Special apology line for the MK-261104-003 late-cancel fee error only. */
export const MK_261104_003_REFUND_APOLOGY =
  "The cancellation fee was charged in error while we were finding a replacement driver. We’re sorry for the mistake.";

export function formatRefundAmountGbp(amountPence: number): string {
  const pence = Math.max(0, Math.round(Number(amountPence) || 0));
  return `£${(pence / 100).toFixed(2)}`;
}

export function buildCustomerRefundNotifyCopy(args: {
  amountPence: number;
  bookingReference: string;
  tripCode?: string | null;
}): { title: string; body: string; subject: string } {
  const amount = formatRefundAmountGbp(args.amountPence);
  const booking = String(args.bookingReference ?? "").trim() || "your booking";
  const title = `Your ONECAB refund: ${amount}`;
  let body =
    `We’ve refunded ${amount} for booking ${booking} to your original payment method. ` +
    `The refund may take time to appear in your account.`;
  const tripCode = String(args.tripCode ?? booking).trim().toUpperCase();
  if (tripCode === "MK-261104-003") {
    body = `${body}\n\n${MK_261104_003_REFUND_APOLOGY}`;
  }
  return { title, body, subject: title };
}

/** Confirmed refunds only — pending/failed/hold-release must not notify. */
export function shouldNotifyCustomerRefund(args: {
  providerRefundId: string | null | undefined;
  amountPence: number | null | undefined;
  refundStatus?: string | null;
  isHoldRelease?: boolean;
}): boolean {
  if (args.isHoldRelease === true) return false;
  const refundId = String(args.providerRefundId ?? "").trim();
  if (!refundId) return false;
  const amount = Math.round(Number(args.amountPence ?? 0));
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const status = String(args.refundStatus ?? "confirmed").trim().toLowerCase();
  if (status === "pending" || status === "failed" || status === "declined" || status === "cancelled") {
    return false;
  }
  return true;
}

export function refundNotifyClaimKey(providerRefundId: string, channel: RefundNotifyChannel): string {
  return `${String(providerRefundId).trim()}:${channel}`;
}
