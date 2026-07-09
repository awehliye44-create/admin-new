/**
 * Phase 6 — resolve trip payment provider for admin ops (legacy Stripe vs Revolut).
 */

export type TripPaymentProvider = "stripe" | "revolut" | "unknown";

export type TripProviderRow = {
  payment_provider?: string | null;
  provider_order_id?: string | null;
  stripe_payment_intent_id?: string | null;
};

export function looksLikeStripePaymentIntentId(value: string | null | undefined): boolean {
  return String(value ?? "").trim().startsWith("pi_");
}

export function resolveTripPaymentProvider(trip: TripProviderRow): TripPaymentProvider {
  const explicit = String(trip.payment_provider ?? "").trim().toLowerCase();
  if (explicit === "revolut") return "revolut";
  if (explicit === "stripe") return "stripe";

  if (trip.provider_order_id && !looksLikeStripePaymentIntentId(trip.stripe_payment_intent_id)) {
    return "revolut";
  }
  if (looksLikeStripePaymentIntentId(trip.stripe_payment_intent_id)) {
    return "stripe";
  }
  if (trip.provider_order_id) return "revolut";
  return "unknown";
}

export function tripProviderOrderId(trip: TripProviderRow): string | null {
  const orderId = String(trip.provider_order_id ?? "").trim();
  if (orderId) return orderId;
  const pi = String(trip.stripe_payment_intent_id ?? "").trim();
  if (pi && !looksLikeStripePaymentIntentId(pi)) return pi;
  return null;
}

export function tripStripePaymentIntentId(trip: TripProviderRow): string | null {
  const pi = String(trip.stripe_payment_intent_id ?? "").trim();
  return looksLikeStripePaymentIntentId(pi) ? pi : null;
}
