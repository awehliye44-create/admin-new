/**
 * Resolve trip payment provider for admin ops / settlement gates.
 * Revolut is the only active card provider.
 */

export type TripPaymentProvider = "revolut" | "unknown" | "legacy_stripe";

export type TripProviderRow = {
  payment_provider?: string | null;
  provider_order_id?: string | null;
  payment_session_id?: string | null;
};

export function resolveTripPaymentProvider(trip: TripProviderRow): TripPaymentProvider {
  const explicit = String(trip.payment_provider ?? "").trim().toLowerCase();
  if (explicit === "revolut") return "revolut";
  // Legacy provider name — never treat as an active settlement provider.
  if (explicit === "stripe") return "legacy_stripe";

  if (trip.provider_order_id) return "revolut";
  if (trip.payment_session_id) return "revolut";
  return "unknown";
}

export function tripProviderOrderId(trip: TripProviderRow): string | null {
  const orderId = String(trip.provider_order_id ?? "").trim();
  return orderId || null;
}
