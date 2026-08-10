/**
 * Phase 6 — resolve trip payment provider for admin ops (legacy Stripe vs Revolut).
 */

export type TripPaymentProvider = "stripe" | "revolut" | "unknown";

export type TripProviderRow = {
  payment_provider?: string | null;
  provider_order_id?: string | null;
  provider_payment_id?: string | null;
};

export function looksLikeProviderPaymentIntentId(value: string | null | undefined): boolean {
  return String(value ?? "").trim().startsWith("pi_");
}

export function resolveTripPaymentProvider(trip: TripProviderRow): TripPaymentProvider {
  const explicit = String(trip.payment_provider ?? "").trim().toLowerCase();
  if (explicit === "revolut") return "revolut";
  if (explicit === "stripe") return "stripe";

  if (trip.provider_order_id && !looksLikeProviderPaymentIntentId(trip.provider_payment_id)) {
    return "revolut";
  }
  if (looksLikeProviderPaymentIntentId(trip.provider_payment_id)) {
    return "stripe";
  }
  if (trip.provider_order_id) return "revolut";
  return "unknown";
}

export function tripProviderOrderId(trip: TripProviderRow): string | null {
  const orderId = String(trip.provider_order_id ?? "").trim();
  if (orderId) return orderId;
  const pi = String(trip.provider_payment_id ?? "").trim();
  if (pi && !looksLikeProviderPaymentIntentId(pi)) return pi;
  return null;
}

export function tripProviderPaymentIntentId(trip: TripProviderRow): string | null {
  const pi = String(trip.provider_payment_id ?? "").trim();
  return looksLikeProviderPaymentIntentId(pi) ? pi : null;
}
