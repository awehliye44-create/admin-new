/**
 * MK-261105-002 — durable customer payment-failure notices (OK-ack).
 * Server upsert is independent of push/UI; acknowledgement never gates cancel.
 */

import {
  BOOKING_CANCELLED_PAYMENT_LOST_MESSAGE,
  BOOKING_CANCELLED_PAYMENT_LOST_TITLE,
  dedupeKeyForModificationUnchanged,
  dedupeKeyForModificationUnchangedAttempt,
  MODIFICATION_UNCHANGED_CUSTOMER_MESSAGE,
  TRIP_CANCELLED_PAYMENT_LOST_MESSAGE,
  TRIP_CANCELLED_PAYMENT_LOST_TITLE,
} from "./modificationHoldLivenessSSOT.ts";
import { TRIP_CHANGE_BANK_DECLINED_CUSTOMER_MESSAGE } from "./revolutCustomerError.ts";

export const PAYMENT_FAILURE_NOTICE_COPY = {
  booking_not_created: {
    kind: "booking_not_created" as const,
    title: "Ride not booked",
    message: "Your ride wasn’t booked because we couldn’t authorise your payment.",
  },
  booking_cancelled_payment: {
    kind: "booking_cancelled_payment" as const,
    title: BOOKING_CANCELLED_PAYMENT_LOST_TITLE,
    message: BOOKING_CANCELLED_PAYMENT_LOST_MESSAGE,
  },
  trip_cancelled_payment: {
    kind: "trip_cancelled_payment" as const,
    title: TRIP_CANCELLED_PAYMENT_LOST_TITLE,
    message: TRIP_CANCELLED_PAYMENT_LOST_MESSAGE,
  },
  modification_unchanged: {
    kind: "modification_unchanged" as const,
    title: "Change not applied",
    message: MODIFICATION_UNCHANGED_CUSTOMER_MESSAGE,
  },
} as const;

export type PaymentFailureNoticeKind = keyof typeof PAYMENT_FAILURE_NOTICE_COPY;

export function dedupeKeyForBookingNotCreated(clientActionId: string): string {
  return `booking_not_created:cai:${String(clientActionId).trim()}`;
}

export function dedupeKeyForBookingCancelledPayment(tripId: string): string {
  return `booking_cancelled_payment:trip:${String(tripId).trim()}`;
}

export function dedupeKeyForTripCancelledPayment(tripId: string): string {
  return `trip_cancelled_payment:trip:${String(tripId).trim()}`;
}

function resolveDedupeKey(args: {
  kind: PaymentFailureNoticeKind;
  clientActionId?: string | null;
  tripId?: string | null;
  changeRequestId?: string | null;
  attemptId?: string | null;
}): string {
  switch (args.kind) {
    case "booking_not_created":
      return dedupeKeyForBookingNotCreated(String(args.clientActionId ?? ""));
    case "booking_cancelled_payment":
      return dedupeKeyForBookingCancelledPayment(String(args.tripId ?? ""));
    case "trip_cancelled_payment":
      return dedupeKeyForTripCancelledPayment(String(args.tripId ?? ""));
    case "modification_unchanged":
      if (args.changeRequestId) {
        return dedupeKeyForModificationUnchanged(String(args.changeRequestId));
      }
      return dedupeKeyForModificationUnchangedAttempt(
        String(args.tripId ?? ""),
        String(args.attemptId ?? crypto.randomUUID()),
      );
  }
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
    changeRequestId?: string | null;
    attemptId?: string | null;
    /** Optional override — bank-decline wording for mod failures when evidenced. */
    title?: string | null;
    message?: string | null;
  },
): Promise<{ id: string | null; error?: string }> {
  const copy = PAYMENT_FAILURE_NOTICE_COPY[args.kind];
  const dedupeKey = resolveDedupeKey(args);
  if (!args.passengerId || !dedupeKey.includes(":")) {
    return { id: null, error: "invalid_notice_args" };
  }
  const { data, error } = await supabase.rpc("upsert_customer_payment_failure_notice", {
    p_passenger_id: args.passengerId,
    p_kind: copy.kind,
    p_title: String(args.title ?? copy.title).trim() || copy.title,
    p_message: String(args.message ?? copy.message).trim() || copy.message,
    p_dedupe_key: dedupeKey,
    p_client_action_id: args.clientActionId ?? null,
    p_trip_id: args.tripId ?? null,
    p_payment_session_id: args.paymentSessionId ?? null,
    p_provider_order_id: args.providerOrderId ?? null,
  });
  if (error) return { id: null, error: error.message };
  return { id: data ? String(data) : null };
}

/** Durable OK-ack for a failed trip change that left the original trip valid. */
// deno-lint-ignore no-explicit-any
export async function upsertModificationUnchangedNotice(
  supabase: any,
  args: {
    passengerId: string;
    tripId: string;
    changeRequestId?: string | null;
    attemptId?: string | null;
    paymentSessionId?: string | null;
    providerOrderId?: string | null;
    bankDeclined?: boolean;
  },
): Promise<{ id: string | null; error?: string }> {
  return await upsertCustomerPaymentFailureNotice(supabase, {
    passengerId: args.passengerId,
    kind: "modification_unchanged",
    tripId: args.tripId,
    changeRequestId: args.changeRequestId,
    attemptId: args.attemptId,
    paymentSessionId: args.paymentSessionId,
    providerOrderId: args.providerOrderId,
    title: args.bankDeclined ? "Payment declined by your bank" : undefined,
    message: args.bankDeclined
      ? TRIP_CHANGE_BANK_DECLINED_CUSTOMER_MESSAGE
      : MODIFICATION_UNCHANGED_CUSTOMER_MESSAGE,
  });
}
