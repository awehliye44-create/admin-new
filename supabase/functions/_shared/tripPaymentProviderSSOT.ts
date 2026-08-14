/**
 * Resolve trip payment provider for admin ops / settlement gates.
 * Revolut is the only active card provider. Stripe IDs are legacy evidence only.
 */

export type TripPaymentProvider = "revolut" | "unknown" | "legacy_stripe";

export type TripProviderRow = {
  payment_provider?: string | null;
  provider_order_id?: string | null;
  payment_session_id?: string | null;
  /** @deprecated legacy column — never use for active settlement gates */
  stripe_payment_intent_id?: string | null;
};

export function looksLikeStripePaymentIntentId(value: string | null | undefined): boolean {
  return String(value ?? "").trim().startsWith("pi_");
}

export function resolveTripPaymentProvider(trip: TripProviderRow): TripPaymentProvider {
  const explicit = String(trip.payment_provider ?? "").trim().toLowerCase();
  if (explicit === "revolut") return "revolut";
  // Stripe is retired — never treat as an active settlement provider.
  if (explicit === "stripe") return "legacy_stripe";

  if (trip.provider_order_id) return "revolut";
  if (trip.payment_session_id) return "revolut";
  // Mis-stored Revolut order ids in legacy stripe_payment_intent_id column
  const legacy = String(trip.stripe_payment_intent_id ?? "").trim();
  if (legacy && !looksLikeStripePaymentIntentId(legacy)) return "revolut";
  if (looksLikeStripePaymentIntentId(legacy)) return "legacy_stripe";
  return "unknown";
}

export function tripProviderOrderId(trip: TripProviderRow): string | null {
  const orderId = String(trip.provider_order_id ?? "").trim();
  if (orderId) return orderId;
  const legacy = String(trip.stripe_payment_intent_id ?? "").trim();
  if (legacy && !looksLikeStripePaymentIntentId(legacy)) return legacy;
  return null;
}

/** @deprecated Stripe is retired — always returns null for active flows */
export function tripStripePaymentIntentId(_trip: TripProviderRow): string | null {
  return null;
}
