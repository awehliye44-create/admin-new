/**
 * Stamp trips.customer_negotiation_view after durable negotiation commits.
 * Customer Realtime merges this into raw.negotiation without full restore.
 */

import {
  buildCustomerNegotiationView,
  type CustomerNegotiationView,
} from "./customerNegotiationView.ts";

export type StampedCustomerNegotiationView = CustomerNegotiationView & {
  offer_version: number;
  server_now: string;
  stamped_at: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function withNegotiationStampMeta(
  view: CustomerNegotiationView,
  offerVersion: number | null | undefined,
): StampedCustomerNegotiationView {
  const nowIso = new Date().toISOString();
  const version =
    typeof offerVersion === "number" && Number.isFinite(offerVersion) && offerVersion > 0
      ? Math.round(offerVersion)
      : 1;
  return {
    ...view,
    offer_version: version,
    server_now: nowIso,
    stamped_at: nowIso,
  };
}

export async function stampCustomerNegotiationViewOnTrip(
  supabase: { from: (table: string) => any },
  tripId: string,
  view: StampedCustomerNegotiationView | CustomerNegotiationView | null,
): Promise<void> {
  const payload =
    view == null
      ? null
      : "server_now" in view && typeof (view as StampedCustomerNegotiationView).server_now === "string"
        ? view
        : withNegotiationStampMeta(view, 1);

  const { error } = await supabase
    .from("trips")
    .update({
      customer_negotiation_view: payload,
      updated_at: new Date().toISOString(),
    })
    .eq("id", tripId);

  if (error) {
    console.warn("[stampCustomerNegotiationView] trip stamp failed:", {
      trip_id: tripId,
      message: error.message,
    });
  }
}

export async function clearCustomerNegotiationViewOnTrip(
  supabase: { from: (table: string) => any },
  tripId: string,
): Promise<void> {
  await stampCustomerNegotiationViewOnTrip(supabase, tripId, null);
}

/** Load offer row + stamp waiting_customer / waiting_driver_final view. */
export async function stampNegotiationViewFromOfferId(
  supabase: { from: (table: string) => any },
  args: {
    tripId: string;
    offerId: string;
    originalFarePence: number;
  },
): Promise<StampedCustomerNegotiationView | null> {
  const { data, error } = await supabase
    .from("ride_offers")
    .select(
      "id, negotiation_status, driver_offer_fare, customer_counter_fare, customer_respond_by, driver_respond_by, negotiation_expires_at, expires_at, offer_snapshot, offer_version",
    )
    .eq("id", args.offerId)
    .maybeSingle();

  if (error || !data) {
    console.warn("[stampCustomerNegotiationView] offer load failed:", {
      offer_id: args.offerId,
      message: error?.message ?? "missing",
    });
    return null;
  }

  const offer = asRecord(data);
  if (!offer?.id || typeof offer.id !== "string") return null;

  const view = buildCustomerNegotiationView({
    offer: {
      id: offer.id,
      negotiation_status: typeof offer.negotiation_status === "string" ? offer.negotiation_status : null,
      driver_offer_fare: Number(offer.driver_offer_fare) || null,
      customer_counter_fare: Number(offer.customer_counter_fare) || null,
      customer_respond_by: typeof offer.customer_respond_by === "string" ? offer.customer_respond_by : null,
      driver_respond_by: typeof offer.driver_respond_by === "string" ? offer.driver_respond_by : null,
      negotiation_expires_at:
        typeof offer.negotiation_expires_at === "string" ? offer.negotiation_expires_at : null,
      expires_at: typeof offer.expires_at === "string" ? offer.expires_at : null,
      offer_snapshot: offer.offer_snapshot,
    },
    originalFarePence: args.originalFarePence,
  });

  if (!view) {
    await clearCustomerNegotiationViewOnTrip(supabase, args.tripId);
    return null;
  }

  const stamped = withNegotiationStampMeta(view, Number(offer.offer_version) || 1);
  await stampCustomerNegotiationViewOnTrip(supabase, args.tripId, stamped);
  return stamped;
}
