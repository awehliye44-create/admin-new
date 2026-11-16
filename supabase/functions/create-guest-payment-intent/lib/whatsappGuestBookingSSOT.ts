/**
 * WhatsApp guest booking identity and checkout snapshot.
 *
 * The trip is still created only by create-trip-after-payment.
 * This module does not price, dispatch, or insert trips.
 */

export const WHATSAPP_GUEST_BOOKING_SOURCE = "whatsapp_booking";

const WHATSAPP_BOOKING_SOURCES = new Set([
  "whatsapp_booking",
  "whatsapp-booking",
  "whatsapp",
]);

export type WhatsAppCheckoutPaymentMethod = "card" | "apple_pay" | "google_pay";

export type ServiceAreaDigitalPaymentFlags = {
  card: boolean;
  applePay: boolean;
  googlePay: boolean;
};

const BLOCKED_RIDER_STATUSES = new Set(["disabled", "suspended", "banned", "blocked"]);

export function normalizeWhatsAppPhoneDigits(raw: string | null | undefined): string {
  return String(raw ?? "").replace(/\D/g, "");
}

/** Exact digit match. Last-10 suffix is not ownership. */
export function phonesExactlyMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = normalizeWhatsAppPhoneDigits(a);
  const right = normalizeWhatsAppPhoneDigits(b);
  return left.length >= 10 && left === right;
}

/** E.164 for GoTrue and customers.phone. Null when the WhatsApp id is not a phone. */
export function whatsAppWaIdToE164(waId: string | null | undefined): string | null {
  const digits = normalizeWhatsAppPhoneDigits(waId);
  if (digits.length < 10 || digits.length > 15) return null;
  return `+${digits}`;
}

/** customers.first_name / last_name both require at least 2 characters. */
export function splitPassengerName(raw: string): { firstName: string; lastName: string } {
  const trimmed = raw.trim().slice(0, 80);
  const parts = trimmed.split(/\s+/).filter(Boolean);
  let firstName = (parts[0] ?? "").slice(0, 80);
  let lastName = parts.slice(1).join(" ").slice(0, 80);
  if (firstName.length < 2) firstName = trimmed;
  if (lastName.trim().length < 2) lastName = firstName;
  return { firstName, lastName };
}

export function isBlockedRiderStatus(status: string | null | undefined): boolean {
  return BLOCKED_RIDER_STATUSES.has(String(status ?? "").trim().toLowerCase());
}

export function isWhatsAppGuestBookingSource(raw: unknown): boolean {
  const normalized = String(raw ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (!normalized) return false;
  if (WHATSAPP_BOOKING_SOURCES.has(normalized) || WHATSAPP_BOOKING_SOURCES.has(String(raw ?? "").trim().toLowerCase())) {
    return true;
  }
  return normalized.includes("whatsapp");
}

export function isWhatsAppGuestBookingSession(session: {
  booking_snapshot?: unknown;
  metadata?: unknown;
} | null | undefined): boolean {
  const snap = asRecord(session?.booking_snapshot);
  const meta = asRecord(session?.metadata);
  return isWhatsAppGuestBookingSource(snap.booking_source) || isWhatsAppGuestBookingSource(meta.booking_source);
}

export function enabledWhatsAppPaymentMethods(
  flags: ServiceAreaDigitalPaymentFlags,
): WhatsAppCheckoutPaymentMethod[] {
  const methods: WhatsAppCheckoutPaymentMethod[] = [];
  if (flags.card) methods.push("card");
  if (flags.applePay) methods.push("apple_pay");
  if (flags.googlePay) methods.push("google_pay");
  return methods;
}

export function resolveWhatsAppCheckoutPaymentMethod(
  requested: unknown,
  flags: ServiceAreaDigitalPaymentFlags,
): WhatsAppCheckoutPaymentMethod | null {
  const enabled = enabledWhatsAppPaymentMethods(flags);
  const asked = String(requested ?? "").trim().toLowerCase();
  if (asked && enabled.includes(asked as WhatsAppCheckoutPaymentMethod)) {
    return asked as WhatsAppCheckoutPaymentMethod;
  }
  if (!asked && enabled.includes("card")) return "card";
  return null;
}

/**
 * Revolut hosted checkout returns only to this URL after a successful authorisation.
 * Client return_url is ignored so a page cannot choose the post-payment host.
 */
export function buildWhatsAppCheckoutRedirectUrl(
  publicOrigin: string,
  continuationToken: string,
): string | null {
  const token = continuationToken.trim();
  if (!token) return null;
  let origin: URL;
  try {
    origin = new URL(publicOrigin);
  } catch {
    return null;
  }
  if (origin.protocol !== "https:") return null;
  const host = origin.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local")) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  const url = `${origin.origin}/whatsapp-track?wa=${encodeURIComponent(token)}`;
  if (url.length > 2000) return null;
  return url;
}

export type WhatsAppGuestSnapshotInput = {
  serviceAreaId: string;
  vehicleTypeId: string;
  amountPence: number;
  currency: string;
  paymentMethod: string;
  pickupAddress: string;
  pickupLat: number;
  pickupLng: number;
  dropoffAddress: string;
  dropoffLat: number;
  dropoffLng: number;
  stops: Array<{ sequence?: number; address?: string | null; lat: number; lng: number }>;
  estimatedDistanceKm: number;
  estimatedDurationMin: number;
  passengerName: string;
  passengerPhone: string;
  customerId: string;
  clientActionId: string;
  providerOrderId: string;
  continuationToken: string;
  waId: string;
  redirectUrl: string;
};

/** One snapshot shape for payment_sessions and create-trip-after-payment. */
export function buildWhatsAppGuestBookingSnapshot(
  input: WhatsAppGuestSnapshotInput,
): Record<string, unknown> {
  const name = input.passengerName.trim();
  const phone = input.passengerPhone.trim();
  const farePounds = Math.round(input.amountPence) / 100;
  return {
    booking_source: WHATSAPP_GUEST_BOOKING_SOURCE,
    when: "NOW",
    vehicle_type_id: input.vehicleTypeId,
    service_area_id: input.serviceAreaId,
    estimated_fare: farePounds,
    estimated_fare_pence: Math.round(input.amountPence),
    estimated_distance: input.estimatedDistanceKm,
    estimated_duration: input.estimatedDurationMin,
    currency: input.currency,
    payment_method: input.paymentMethod,
    payment_method_type: input.paymentMethod,
    pickup_address: input.pickupAddress,
    pickup_lat: input.pickupLat,
    pickup_lng: input.pickupLng,
    dropoff_address: input.dropoffAddress,
    dropoff_lat: input.dropoffLat,
    dropoff_lng: input.dropoffLng,
    pickup: { lat: input.pickupLat, lng: input.pickupLng, address: input.pickupAddress },
    dropoff: { lat: input.dropoffLat, lng: input.dropoffLng, address: input.dropoffAddress },
    stops: input.stops.map((stop, index) => ({
      sequence: stop.sequence ?? index,
      address: stop.address ?? "",
      lat: stop.lat,
      lng: stop.lng,
    })),
    waypoints: input.stops.map((stop) => ({ lat: stop.lat, lng: stop.lng })),
    scheduled_at: null,
    customer_name: name,
    customer_phone: phone,
    passenger_name: name,
    passenger_phone: phone,
    passenger_id: input.customerId,
    client_action_id: input.clientActionId,
    payment_intent_id: input.providerOrderId,
    return_url: input.redirectUrl,
    redirect_url: input.redirectUrl,
    wa_id: input.waId,
    continuation_token: input.continuationToken,
  };
}

/** Backfill the CTAP field names without inventing a phone the snapshot does not already have. */
export function ensureWhatsAppSnapshotReadyForTripCreate(
  snapshot: Record<string, unknown>,
  providerOrderId: string,
): Record<string, unknown> {
  const next = { ...snapshot };
  if (!String(next.payment_intent_id ?? "").trim() && providerOrderId.trim()) {
    next.payment_intent_id = providerOrderId.trim();
  }
  const name = String(next.passenger_name ?? next.customer_name ?? "").trim();
  const phone = String(next.passenger_phone ?? next.customer_phone ?? "").trim();
  if (name) {
    next.passenger_name = name;
    next.customer_name = String(next.customer_name ?? "").trim() || name;
  }
  if (phone) {
    next.passenger_phone = phone;
    next.customer_phone = String(next.customer_phone ?? "").trim() || phone;
  }
  if (!next.when) next.when = "NOW";
  if (next.estimated_fare == null && typeof next.estimated_fare_pence === "number") {
    next.estimated_fare = next.estimated_fare_pence / 100;
  }
  return next;
}

export function shouldClaimWhatsAppAutoDispatch(metadata: unknown): boolean {
  const meta = asRecord(metadata);
  return !String(meta.auto_dispatch_invoked_at ?? "").trim()
    && !String(meta.auto_dispatch_claimed_at ?? "").trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
