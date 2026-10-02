/**
 * Booking-failure preauth reversal — Revolut holds are cancelled via
 * cancelRevolutOrder / holdRelease SSOT. Legacy PI helpers are no-ops.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

/** Customer-safe copy when booking fails after a hold was placed. */
export const BOOKING_FAILED_NO_TRIP_MESSAGE =
  "We couldn't complete your booking. No booking has been created. Please try again in a moment or choose another payment method.";

export const AUTHORIZED_PREAUTH_STATUSES = new Set(["requires_capture", "succeeded"]);

export type PreauthReversalStatus =
  | "cancelled"
  | "refunded"
  | "none"
  | "failed"
  | "skipped_trip_exists"
  | "skipped_not_authorized"
  | "skipped_no_provider";

export function isAuthorizedPreauthStatus(status: string): boolean {
  return AUTHORIZED_PREAUTH_STATUSES.has(status);
}

/** No-op — Revolut holds must be reversed via Revolut SSOT helpers. */
export async function reverseOpenPaymentIntent(
  _unusedProviderClient: unknown,
  paymentIntent: { id?: string; status?: string },
): Promise<PreauthReversalStatus> {
  console.info("[BOOKING_PREAUTH_REVERSAL] reverse skipped — no provider adapter", {
    payment_intent_id: paymentIntent?.id ?? null,
    status: paymentIntent?.status ?? null,
  });
  return "skipped_no_provider";
}

/** No-op — Revolut holds must be reversed via Revolut SSOT helpers. */
export async function cancelPreauthWhenNoBooking(
  _supabase: SupabaseClient,
  _unusedProviderClient: unknown,
  args: {
    paymentIntent: { id?: string; status?: string; amount?: number };
    userId: string;
    customerId?: string | null;
    clientActionId?: string | null;
    serviceAreaId?: string | null;
    failureReason: string;
    failureStage: string;
    allowTerminalTrip?: boolean;
  },
): Promise<PreauthReversalStatus> {
  console.info("[BOOKING_PREAUTH_REVERSAL] cancel skipped — no provider adapter", {
    payment_intent_id: args.paymentIntent?.id ?? null,
    failure_stage: args.failureStage,
    failure_reason: args.failureReason,
    client_action_id: args.clientActionId ?? null,
    user_id: args.userId,
  });
  return "skipped_no_provider";
}
