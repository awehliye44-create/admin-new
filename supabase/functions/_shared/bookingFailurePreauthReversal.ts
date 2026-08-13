import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  assertStripeMutationAllowedOrThrow,
  STRIPE_RETIRED,
} from "./stripeRuntimeDisabled.ts";

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
  | "skipped_stripe_retired";

export function isAuthorizedPreauthStatus(status: string): boolean {
  return AUTHORIZED_PREAUTH_STATUSES.has(status);
}

/**
 * Stripe PI reversal is permanently retired. Revolut holds are cancelled via
 * cancelRevolutOrder in create-trip-after-payment — do not call Stripe APIs.
 */
export async function reverseOpenPaymentIntent(
  _stripe: unknown,
  paymentIntent: { id?: string; status?: string },
): Promise<PreauthReversalStatus> {
  assertStripeMutationAllowedOrThrow("bookingFailurePreauthReversal:reverseOpenPaymentIntent");
  console.info("[BOOKING_PREAUTH_REVERSAL] Stripe reverse skipped — retired", {
    payment_intent_id: paymentIntent?.id ?? null,
    status: paymentIntent?.status ?? null,
    error_code: STRIPE_RETIRED,
  });
  return "skipped_stripe_retired";
}

/**
 * Legacy Stripe booking-failure reversal — no live Stripe mutations.
 * Callers must reverse Revolut holds via Revolut SSOT helpers instead.
 */
export async function cancelPreauthWhenNoBooking(
  _supabase: SupabaseClient,
  _stripe: unknown,
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
  assertStripeMutationAllowedOrThrow("bookingFailurePreauthReversal:cancelPreauthWhenNoBooking");
  console.info("[BOOKING_PREAUTH_REVERSAL] Stripe cancel skipped — retired", {
    payment_intent_id: args.paymentIntent?.id ?? null,
    failure_stage: args.failureStage,
    failure_reason: args.failureReason,
    client_action_id: args.clientActionId ?? null,
    user_id: args.userId,
    error_code: STRIPE_RETIRED,
  });
  return "skipped_stripe_retired";
}
