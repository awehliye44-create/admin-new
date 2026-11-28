/** Admin presentation-only helpers; not part of Edge uploads. */


export const NON_FINALISING_PROVIDER_STATES = new Set([
  "created",
  "pending",
  "submitted",
  "processing",
  "failed",
  "declined",
  "cancelled",
  "canceled",
  "reverted",
  "unknown",
  "",
]);


export function completionDebitIdempotencyKey(providerPaymentId: string): string {
  return `revolut-payout-completion:${String(providerPaymentId).trim()}`;
}


export function completionLedgerDescription(args: {
  payout_item_id: string;
  provider_payment_id: string;
  reservation_id?: string | null;
}): string {
  const res = args.reservation_id ? ` reservation=${args.reservation_id}` : "";
  return (
    `Revolut payout completion debit item=${args.payout_item_id}` +
    ` payment=${args.provider_payment_id}${res}`
  );
}
