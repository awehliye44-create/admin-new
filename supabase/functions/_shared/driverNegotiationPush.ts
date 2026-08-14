/**
 * Negotiation metadata for driver FCM data payloads (Android OfferStateStore).
 */

export type RideOfferNegotiationPushFields = {
  negotiation_status?: string;
  negotiation_expires_at?: string;
  customer_counter_fare?: string;
  preset_options_count?: string;
  preset_fares_pence?: string;
};

function countPresetOptions(snapshot: unknown): number {
  if (!snapshot || typeof snapshot !== "object") return 0;
  const raw = (snapshot as { preset_options?: unknown }).preset_options;
  return Array.isArray(raw) ? raw.length : 0;
}

function presetFaresPenceFromSnapshot(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== "object") return "";
  const raw = (snapshot as { preset_options?: unknown[] }).preset_options;
  if (!Array.isArray(raw)) return "";
  const fares: number[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const pence = (entry as { grossFarePence?: number; gross_fare_pence?: number })
      .grossFarePence
      ?? (entry as { gross_fare_pence?: number }).gross_fare_pence;
    if (typeof pence === "number" && Number.isFinite(pence) && pence > 0) {
      fares.push(Math.round(pence));
    }
  }
  return fares.join(",");
}

export function buildDriverNegotiationPushData(input: {
  offer_id: string;
  trip_id: string;
  offerId?: string;
  tripId?: string;
  negotiation_status?: string | null;
  negotiation_expires_at?: string | null;
  customer_counter_fare?: number | null;
  offer_snapshot?: unknown;
  expires_at?: string | null;
  notificationType?: string;
}): Record<string, string> {
  const presetCount = countPresetOptions(input.offer_snapshot);
  const presetFares = presetFaresPenceFromSnapshot(input.offer_snapshot);
  const data: Record<string, string> = {
    type: "NEGOTIATION_UPDATE",
    notificationType: input.notificationType ?? "customer_counter_offer",
    offer_id: input.offer_id,
    offerId: input.offerId ?? input.offer_id,
    trip_id: input.trip_id,
    tripId: input.tripId ?? input.trip_id,
    booking_id: input.trip_id,
    bookingId: input.trip_id,
  };
  if (input.negotiation_status) {
    data.negotiation_status = input.negotiation_status;
    data.negotiationStatus = input.negotiation_status;
  }
  if (input.negotiation_expires_at) {
    data.negotiation_expires_at = input.negotiation_expires_at;
    data.negotiationExpiresAt = input.negotiation_expires_at;
  }
  if (input.expires_at) {
    data.expires_at = input.expires_at;
  }
  if (input.customer_counter_fare != null && input.customer_counter_fare > 0) {
    const fare = String(Math.round(input.customer_counter_fare));
    data.customer_counter_fare = fare;
    data.customerCounterFare = fare;
  }
  if (presetCount > 0) {
    data.preset_options_count = String(presetCount);
    data.presetOptionsCount = String(presetCount);
  }
  if (presetFares) {
    data.preset_fares_pence = presetFares;
    data.presetFaresPence = presetFares;
  }
  return data;
}

export function appendNegotiationFieldsToRideOfferData(
  data: Record<string, string>,
  input: {
    negotiation_status?: string | null;
    negotiation_expires_at?: string | null;
    customer_counter_fare?: number | null;
    offer_snapshot?: unknown;
  },
): Record<string, string> {
  const extra = buildDriverNegotiationPushData({
    offer_id: data.offer_id ?? data.offerId ?? "",
    trip_id: data.trip_id ?? data.tripId ?? "",
    negotiation_status: input.negotiation_status,
    negotiation_expires_at: input.negotiation_expires_at,
    customer_counter_fare: input.customer_counter_fare,
    offer_snapshot: input.offer_snapshot,
    notificationType: data.notificationType,
  });
  return { ...data, ...extra };
}
