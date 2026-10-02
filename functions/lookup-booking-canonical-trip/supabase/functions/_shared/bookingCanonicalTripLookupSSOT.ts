/**
 * CTAP-in-flight canonical trip discovery (MK-260926-007).
 * Read-only: finds an already-inserted trip by client_action_id + ownership.
 * Never mutates payment/wallet/trip state.
 */

export const BOOKING_CANONICAL_TRIP_LOOKUP_SELECT =
  "id, trip_code, status, dispatch_status, dispatch_mode, pickup_address, dropoff_address, pickup_latitude, pickup_longitude, dropoff_latitude, dropoff_longitude, service_area_id, vehicle_type_id, created_at, searching_expires_at, passenger_id, client_action_id, is_scheduled, scheduled_at, scheduled_status, payment_session_id";

/** Live / Finding-eligible statuses for CTAP-inflight adopt (not terminal). */
export const BOOKING_CANONICAL_LIVE_STATUSES = new Set([
  "payment_pending",
  "pending",
  "searching",
  "offered",
  "offering",
  "broadcasting",
  "negotiating",
  "queued",
  "driver_cancelled",
  "searching_new_driver",
  "accepted",
  "confirmed",
  "driver_assigned",
  "en_route",
  "en_route_to_pickup",
  "enroute_to_pickup",
  "driver_en_route",
  "driver_arriving",
  "arrived",
  "arrived_pickup",
  "arrived_at_pickup",
  "at_pickup",
  "pickup_waiting",
  "waiting",
  "in_progress",
  "completing",
  "arrived_at_stop",
  "drive_to_next_stop",
  "scheduled",
  "scheduled_committed",
]);

export const BOOKING_CANONICAL_TERMINAL_STATUSES = new Set([
  "completed",
  "cancelled",
  "canceled",
  "customer_cancelled",
  "no_show",
  "expired",
  "failed",
]);

export type BookingCanonicalTripRow = {
  id: string;
  trip_code: string | null;
  status: string | null;
  dispatch_status: string | null;
  dispatch_mode: string | null;
  pickup_address: string | null;
  dropoff_address: string | null;
  pickup_latitude: number | null;
  pickup_longitude: number | null;
  dropoff_latitude: number | null;
  dropoff_longitude: number | null;
  service_area_id: string | null;
  vehicle_type_id: string | null;
  created_at: string | null;
  searching_expires_at: string | null;
  passenger_id: string | null;
  client_action_id: string | null;
  is_scheduled: boolean | null;
  scheduled_at: string | null;
  scheduled_status: string | null;
  payment_session_id: string | null;
};

export type BookingCanonicalTripSeed = {
  trip_id: string;
  trip_code: string | null;
  status: string;
  dispatch_status: string | null;
  dispatch_mode: string | null;
  pickup_address: string | null;
  dropoff_address: string | null;
  pickup_latitude: number | null;
  pickup_longitude: number | null;
  dropoff_latitude: number | null;
  dropoff_longitude: number | null;
  service_area_id: string | null;
  vehicle_type_id: string | null;
  created_at: string | null;
  searching_expires_at: string | null;
  is_scheduled: boolean;
  scheduled_at: string | null;
  scheduled_status: string | null;
  payment_session_id: string | null;
  client_action_id: string;
};

export function normalizeBookingCanonicalStatus(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

/**
 * Pure gate: owned live booking candidate for this client_action_id.
 * Does not require payment_sessions.trip_id (reverse link may lag T1).
 */
export function evaluateBookingCanonicalTripLookup(input: {
  clientActionId: string;
  customerId: string;
  trip: BookingCanonicalTripRow | null | undefined;
  nowMs?: number;
}):
  | { ok: true; seed: BookingCanonicalTripSeed }
  | { ok: false; reason: string } {
  const clientActionId = String(input.clientActionId ?? "").trim();
  const customerId = String(input.customerId ?? "").trim();
  if (!clientActionId) return { ok: false, reason: "missing_client_action_id" };
  if (!customerId) return { ok: false, reason: "missing_customer_id" };
  const trip = input.trip;
  if (!trip?.id) return { ok: false, reason: "not_found" };

  if (String(trip.client_action_id ?? "").trim() !== clientActionId) {
    return { ok: false, reason: "client_action_id_mismatch" };
  }
  if (String(trip.passenger_id ?? "").trim() !== customerId) {
    return { ok: false, reason: "ownership_mismatch" };
  }

  const status = normalizeBookingCanonicalStatus(trip.status);
  if (!status || BOOKING_CANONICAL_TERMINAL_STATUSES.has(status)) {
    return { ok: false, reason: "terminal_or_empty_status" };
  }
  if (!BOOKING_CANONICAL_LIVE_STATUSES.has(status)) {
    return { ok: false, reason: `status_not_live:${status}` };
  }

  // Searching window expired → not a Finding seed (same spirit as restore).
  if (
    (status === "searching" || status === "offered" || status === "broadcasting") &&
    typeof trip.searching_expires_at === "string"
  ) {
    const ms = new Date(trip.searching_expires_at).getTime();
    const nowMs = input.nowMs ?? Date.now();
    if (Number.isFinite(ms) && nowMs >= ms) {
      return { ok: false, reason: "search_expired" };
    }
  }

  return {
    ok: true,
    seed: {
      trip_id: String(trip.id),
      trip_code: trip.trip_code != null ? String(trip.trip_code) : null,
      status: status,
      dispatch_status: trip.dispatch_status != null ? String(trip.dispatch_status) : null,
      dispatch_mode: trip.dispatch_mode != null ? String(trip.dispatch_mode) : null,
      pickup_address: trip.pickup_address != null ? String(trip.pickup_address) : null,
      dropoff_address: trip.dropoff_address != null ? String(trip.dropoff_address) : null,
      pickup_latitude: trip.pickup_latitude == null ? null : Number(trip.pickup_latitude),
      pickup_longitude: trip.pickup_longitude == null ? null : Number(trip.pickup_longitude),
      dropoff_latitude: trip.dropoff_latitude == null ? null : Number(trip.dropoff_latitude),
      dropoff_longitude: trip.dropoff_longitude == null ? null : Number(trip.dropoff_longitude),
      service_area_id: trip.service_area_id != null ? String(trip.service_area_id) : null,
      vehicle_type_id: trip.vehicle_type_id != null ? String(trip.vehicle_type_id) : null,
      created_at: trip.created_at != null ? String(trip.created_at) : null,
      searching_expires_at: trip.searching_expires_at != null
        ? String(trip.searching_expires_at)
        : null,
      is_scheduled: trip.is_scheduled === true,
      scheduled_at: trip.scheduled_at != null ? String(trip.scheduled_at) : null,
      scheduled_status: trip.scheduled_status != null ? String(trip.scheduled_status) : null,
      payment_session_id: trip.payment_session_id != null
        ? String(trip.payment_session_id)
        : null,
      client_action_id: clientActionId,
    },
  };
}
