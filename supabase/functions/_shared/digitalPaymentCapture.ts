import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { recordCardCaptureFailure } from "./onecabFinanceLedger.ts";

/** Card, Apple Pay, and Google Pay all use a Stripe PaymentIntent (non-cash). */
export function isDigitalStripeTrip(trip: {
  payment_method?: string | null;
  stripe_payment_intent_id?: string | null;
}): boolean {
  const method = (trip.payment_method ?? "").trim().toLowerCase();
  if (method === "cash") return false;
  if (!trip.stripe_payment_intent_id) return false;
  return true;
}

/** @deprecated use recordCardCaptureFailure from onecabFinanceLedger */
export async function recordTripCaptureFailure(
  supabase: SupabaseClient,
  tripId: string,
  message: string,
  stripePaymentIntentId?: string | null,
): Promise<void> {
  await recordCardCaptureFailure(supabase, {
    tripId,
    message,
    stripePaymentIntentId,
  });
}

export { recordCardCaptureFailure };
