/**
 * MK-261105-002 — durable customer payment-failure notices (OK-ack).
 * Server upsert is independent of push/UI; acknowledgement never gates cancel.
 */

export const PAYMENT_FAILURE_NOTICE_COPY = {
  booking_not_created: {
    kind: "booking_not_created" as const,
    title: "Ride not booked",
    message: "Your ride wasn’t booked because we couldn’t authorise your payment.",
  },
  booking_cancelled_payment: {
    kind: "booking_cancelled_payment" as const,
    title: "Booking cancelled",
    message: "Your booking was cancelled because we couldn’t secure payment.",
  },
} as const;

export type PaymentFailureNoticeKind = keyof typeof PAYMENT_FAILURE_NOTICE_COPY;

export function dedupeKeyForBookingNotCreated(clientActionId: string): string {
  return `booking_not_created:cai:${String(clientActionId).trim()}`;
}

export function dedupeKeyForBookingCancelledPayment(tripId: string): string {
  return `booking_cancelled_payment:trip:${String(tripId).trim()}`;
}

// deno-lint-ignore no-explicit-any
export async function upsertCustomerPaymentFailureNotice(
  supabase: any,
  args: {
    passengerId: string;
    kind: PaymentFailureNoticeKind;
    clientActionId?: string | null;
    tripId?: string | null;
    paymentSessionId?: string | null;
    providerOrderId?: string | null;
  },
): Promise<{ id: string | null; error?: string }> {
  const copy = PAYMENT_FAILURE_NOTICE_COPY[args.kind];
  const dedupeKey = args.kind === "booking_not_created"
    ? dedupeKeyForBookingNotCreated(String(args.clientActionId ?? ""))
    : dedupeKeyForBookingCancelledPayment(String(args.tripId ?? ""));
  if (!args.passengerId || !dedupeKey.includes(":")) {
    return { id: null, error: "invalid_notice_args" };
  }
  const { data, error } = await supabase.rpc("upsert_customer_payment_failure_notice", {
    p_passenger_id: args.passengerId,
    p_kind: copy.kind,
    p_title: copy.title,
    p_message: copy.message,
    p_dedupe_key: dedupeKey,
    p_client_action_id: args.clientActionId ?? null,
    p_trip_id: args.tripId ?? null,
    p_payment_session_id: args.paymentSessionId ?? null,
    p_provider_order_id: args.providerOrderId ?? null,
  });
  if (error) return { id: null, error: error.message };
  return { id: data ? String(data) : null };
}
