/**
 * Resolve the trip payment provider for admin ops.
 */

export type TripPaymentProvider = "revolut" | "unknown";

export type TripProviderRow = {
  payment_provider?: string | null;
  provider_order_id?: string | null;
  provider_payment_id?: string | null;
};

export function resolveTripPaymentProvider(trip: TripProviderRow): TripPaymentProvider {
  const explicit = String(trip.payment_provider ?? "").trim().toLowerCase();
  if (explicit === "revolut") return "revolut";
  if (trip.provider_order_id) return "revolut";
  return "unknown";
}

export function tripProviderOrderId(trip: TripProviderRow): string | null {
  const orderId = String(trip.provider_order_id ?? "").trim();
  if (orderId) return orderId;
  const paymentId = String(trip.provider_payment_id ?? "").trim();
  return paymentId || null;
}
