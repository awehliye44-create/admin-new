/**
 * guest-trip-status — opaque WhatsApp continuation token → TripView.
 *
 * Public (anon JWT). Access is the signed continuation token only.
 * A book token resolves the payment session that stored that exact token,
 * then that session's trip. A track token resolves its trip id only when
 * the same wa_id owns that session. Never by MK code or phone suffix.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { corsHeaders } from "../_shared/corsHeaders.ts";
import {
  buildWhatsAppContinuationSigningMaterial,
  createWhatsAppContinuationToken,
  verifyWhatsAppContinuationToken,
  type WhatsAppContinuationClaims,
} from "../_shared/whatsappContinuationToken.ts";
import {
  releaseRevolutPreauthForTrip,
  resolveRevolutOrderIdFromTrip,
} from "../_shared/revolutPreauthReleaseSSOT.ts";
import { notifyWhatsAppNoDriverForTrip } from "../_shared/whatsappNoDriverNotify.ts";
import { phonesExactlyMatch } from "../_shared/whatsappGuestBookingSSOT.ts";
import { getRouteWithCache, type RouteLeg } from "../_shared/routeCache.ts";

const SEARCHING_STATES = new Set([
  "pending",
  "searching",
  "offered",
  "broadcasting",
  "offering",
  "searching_new_driver",
]);

const ARRIVED_STATES = new Set([
  "arrived",
  "arrived_at_pickup",
  "driver_arrived",
]);

const STARTED_STATES = new Set([
  "in_progress",
  "started",
  "trip_started",
  "on_trip",
]);

/** Same list as request-trip-modification allowedStatuses. */
const MODIFIABLE_STATUSES = new Set([
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
  "started",
  "ongoing",
  "at_stop",
  "driving_to_next_stop",
]);

const TERMINAL_STATES = new Set([
  "completed",
  "cancelled",
  "canceled",
  "expired",
  "expired_no_driver",
  "no_drivers",
]);

const TRIP_COLUMNS = [
  "id",
  "trip_number",
  "trip_code",
  "status",
  "dispatch_status",
  "driver_id",
  "confirmed_driver_id",
  "passenger_id",
  "passenger_phone",
  "booking_source",
  "searching_expires_at",
  "pickup_address",
  "dropoff_address",
  "pickup_latitude",
  "pickup_longitude",
  "dropoff_latitude",
  "dropoff_longitude",
  "provider_order_id",
  "payment_provider",
  "payment_status",
  "payment_session_id",
  "vehicle_type",
  "vehicle_type_id",
  "currency",
  "estimated_fare",
  "final_fare_pence",
  "final_customer_fare_pence",
  "free_wait_expires_at",
  "pickup_waiting_started_at",
  "pickup_waiting_counted_seconds",
  "pickup_waiting_chargeable_seconds",
  "pickup_waiting_charge_pence",
  "stop_waiting_started_at",
  "stop_waiting_counted_seconds",
  "stop_waiting_charge_pence",
  "stop_waiting_status",
  "stop_waiting_finalized_at",
  "waiting_geofence_status",
  "created_at",
].join(", ");

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function decodePolyline(encoded: string): [number, number][] {
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    lat += (result & 1) ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    lng += (result & 1) ? ~(result >> 1) : result >> 1;
    coords.push([lng / 1e5, lat / 1e5]);
  }
  return coords;
}

function statusPresentation(status: string, searching: boolean, terminal: boolean) {
  const s = status.toLowerCase();
  if (SEARCHING_STATES.has(s) || searching) {
    return {
      statusLabel: s === "searching_new_driver" ? "Finding your driver" : "Finding your driver",
      statusDetail: s === "searching_new_driver"
        ? "Looking for another ONECAB driver."
        : "We're matching nearby ONECAB drivers to your trip.",
    };
  }
  if (terminal && (s.includes("expire") || s.includes("no_driver") || s === "no_drivers")) {
    return {
      statusLabel: "No drivers available",
      statusDetail: "No drivers are available right now. Please try again.",
    };
  }
  if (terminal && s.includes("cancel")) {
    return { statusLabel: "Trip cancelled", statusDetail: null as string | null };
  }
  if (terminal && s.includes("complete")) {
    return { statusLabel: "Trip completed", statusDetail: null as string | null };
  }
  if (ARRIVED_STATES.has(s)) {
    return { statusLabel: "Driver arrived", statusDetail: "Your driver is at the pickup." };
  }
  if (STARTED_STATES.has(s)) {
    return { statusLabel: "Trip in progress", statusDetail: null as string | null };
  }
  if (s === "driver_en_route" || s === "en_route" || s === "accepted" || s === "driver_assigned") {
    return { statusLabel: "Driver is on the way", statusDetail: null as string | null };
  }
  return { statusLabel: status.replace(/_/g, " "), statusDetail: null as string | null };
}

async function loadTrip(supabase: any, tripId: string) {
  const { data, error } = await supabase
    .from("trips")
    .select(TRIP_COLUMNS)
    .eq("id", tripId)
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ event: "GUEST_TRIP_LOAD_FAILED", code: error.code ?? "select_failed" }));
    return null;
  }
  return data as Record<string, unknown> | null;
}

function snapshotOwnsWa(snapshot: unknown, waId: string): boolean {
  const snap = asRecord(snapshot);
  return phonesExactlyMatch(typeof snap.wa_id === "string" ? snap.wa_id : "", waId)
    && String(snap.booking_source ?? "") === "whatsapp_booking";
}

async function sessionForTrip(supabase: any, trip: Record<string, unknown>) {
  const sessionId = typeof trip.payment_session_id === "string" ? trip.payment_session_id : "";
  if (!sessionId) return null;
  const { data } = await supabase
    .from("payment_sessions")
    .select("id, trip_id, booking_snapshot")
    .eq("id", sessionId)
    .maybeSingle();
  return data as { id: string; trip_id: string | null; booking_snapshot: unknown } | null;
}

async function resolveOwnedTrip(
  supabase: any,
  claims: WhatsAppContinuationClaims,
  token: string,
): Promise<Record<string, unknown> | null> {
  if (claims.tripId) {
    const trip = await loadTrip(supabase, claims.tripId);
    if (!trip) return null;
    const session = await sessionForTrip(supabase, trip);
    if (!session || !snapshotOwnsWa(session.booking_snapshot, claims.waId)) return null;
    if (session.trip_id && session.trip_id !== trip.id) return null;
    return trip;
  }

  const { data: sessions } = await supabase
    .from("payment_sessions")
    .select("id, trip_id, booking_snapshot")
    .contains("booking_snapshot", { continuation_token: token })
    .limit(3);

  const owned = (sessions ?? []).find((row: { booking_snapshot: unknown }) =>
    snapshotOwnsWa(row.booking_snapshot, claims.waId)
  );
  if (!owned) return null;

  if (owned.trip_id) {
    const trip = await loadTrip(supabase, owned.trip_id);
    if (trip && trip.payment_session_id === owned.id) return trip;
  }

  const { data: bySession } = await supabase
    .from("trips")
    .select(TRIP_COLUMNS)
    .eq("payment_session_id", owned.id)
    .maybeSingle();
  return (bySession as Record<string, unknown> | null) ?? null;
}

function farePence(trip: Record<string, unknown>): number | null {
  const finalCustomer = num(trip.final_customer_fare_pence);
  if (finalCustomer != null && finalCustomer > 0) return Math.round(finalCustomer);
  const finalFare = num(trip.final_fare_pence);
  if (finalFare != null && finalFare > 0) return Math.round(finalFare);
  const estimated = num(trip.estimated_fare);
  if (estimated != null && estimated > 0) return Math.round(estimated * 100);
  return null;
}

function waitingView(trip: Record<string, unknown>, nowMs: number) {
  const status = String(trip.status ?? "").toLowerCase();
  const stopStarted = typeof trip.stop_waiting_started_at === "string" ? trip.stop_waiting_started_at : null;
  const stopOpen = Boolean(stopStarted) && !trip.stop_waiting_finalized_at
    && String(trip.stop_waiting_status ?? "").toLowerCase() !== "finalized";
  const pickupStarted = typeof trip.pickup_waiting_started_at === "string"
    ? trip.pickup_waiting_started_at
    : null;
  const arrived = ARRIVED_STATES.has(status) || Boolean(pickupStarted && !STARTED_STATES.has(status));
  if (!stopOpen && !arrived && !pickupStarted) return null;

  const useStop = stopOpen && !arrived;
  const expiresMs = !useStop && typeof trip.free_wait_expires_at === "string"
    ? new Date(trip.free_wait_expires_at).getTime()
    : NaN;
  const freeRemaining = Number.isFinite(expiresMs)
    ? Math.max(0, Math.floor((expiresMs - nowMs) / 1000))
    : null;
  const chargeable = useStop
    ? num(trip.stop_waiting_counted_seconds)
    : num(trip.pickup_waiting_chargeable_seconds);
  const counted = useStop
    ? num(trip.stop_waiting_counted_seconds)
    : num(trip.pickup_waiting_counted_seconds);
  const chargeableElapsed = chargeable ?? 0;
  // Missing free_wait_expires_at is not paid waiting. Chargeable only after
  // the server expiry has passed, or the server has already counted chargeable seconds.
  const phase = freeRemaining != null && freeRemaining > 0
    ? "free"
    : chargeableElapsed > 0 || (Number.isFinite(expiresMs) && expiresMs <= nowMs)
      ? "chargeable"
      : "free";
  const geofence = typeof trip.waiting_geofence_status === "string"
    ? trip.waiting_geofence_status
    : null;
  const paused = useStop && String(trip.stop_waiting_status ?? "").toLowerCase() === "paused";
  return {
    type: useStop ? "stop_waiting" : "pickup_waiting",
    label: useStop ? "Stop waiting" : "Pickup waiting",
    phase,
    freeSecondsRemaining: phase === "free" ? freeRemaining : 0,
    chargeableSecondsElapsed: phase === "chargeable" ? (chargeableElapsed || counted || 0) : 0,
    startedAtIso: useStop ? stopStarted : pickupStarted,
    freeWaitExpiresAt: !useStop && typeof trip.free_wait_expires_at === "string"
      ? trip.free_wait_expires_at
      : null,
    geofenceStatus: geofence,
    paused,
    ruleSummary: [
      paused ? "Waiting is paused" : null,
      geofence ? `Geofence: ${geofence.replace(/_/g, " ")}` : null,
    ].filter(Boolean).join(" · ") || null,
  };
}

async function driverView(supabase: any, trip: Record<string, unknown>) {
  const driverId = (typeof trip.confirmed_driver_id === "string" && trip.confirmed_driver_id)
    || (typeof trip.driver_id === "string" && trip.driver_id)
    || "";
  if (!driverId || SEARCHING_STATES.has(String(trip.status ?? "").toLowerCase())) return null;

  const [{ data: driver }, { data: vehicle }, { data: live }] = await Promise.all([
    supabase
      .from("drivers")
      .select("id, first_name, last_name, profile_photo_url, display_rating, rating, rating_count")
      .eq("id", driverId)
      .maybeSingle(),
    supabase
      .from("vehicles")
      .select("make, model, color, license_plate")
      .eq("driver_id", driverId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Same row the Customer App marker follows (get_trip_driver_live_location / realtime).
    // Columns are latitude/longitude, not the dispatch table's lat/lng.
    supabase
      .from("trip_driver_live_location")
      .select("latitude, longitude, heading, gps_recorded_at, driver_id")
      .eq("trip_id", trip.id)
      .eq("driver_id", driverId)
      .order("gps_recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (!driver) return null;

  const recordedMs = live?.gps_recorded_at ? Date.parse(live.gps_recorded_at) : NaN;
  // Customer App locationMaxStaleMs. A stale sample is omitted, never replaced with pickup.
  const liveFresh = Number.isFinite(recordedMs) && Date.now() - recordedMs < 120_000 && Date.now() - recordedMs >= -5_000;
  const lat = liveFresh ? num(live.latitude) : null;
  const lng = liveFresh ? num(live.longitude) : null;
  const lastInitial = String(driver.last_name ?? "").trim().slice(0, 1);
  const displayName = [driver.first_name, lastInitial].filter(Boolean).join(" ").trim()
    || "ONECAB driver";
  const photo = typeof driver.profile_photo_url === "string" && driver.profile_photo_url.startsWith("https://")
    ? driver.profile_photo_url
    : null;
  return {
    displayName,
    photoUrl: photo,
    rating: num(driver.display_rating) ?? num(driver.rating),
    tripCount: num(driver.rating_count),
    vehicleCategory: typeof trip.vehicle_type === "string" ? trip.vehicle_type : null,
    vehicleMakeModel: [vehicle?.make, vehicle?.model].filter(Boolean).join(" ") || null,
    vehicleColour: vehicle?.color ?? null,
    vehiclePlate: vehicle?.license_plate ?? null,
    lat,
    lng,
    headingDegrees: liveFresh ? num(live?.heading) : null,
    locationSampledAt: liveFresh && typeof live?.gps_recorded_at === "string" ? live.gps_recorded_at : null,
  };
}

async function routeGeometry(
  supabase: any,
  trip: Record<string, unknown>,
  driver: { lat?: number | null; lng?: number | null } | null,
  terminal: boolean,
) {
  const status = String(trip.status ?? "").toLowerCase();
  const leg: RouteLeg = STARTED_STATES.has(status) || SEARCHING_STATES.has(status)
    ? "pickup_to_dropoff"
    : "driver_to_pickup";
  const { data: cached } = await supabase
    .from("trip_route_cache")
    .select("polyline, duration_min, expires_at")
    .eq("trip_id", trip.id)
    .eq("leg", leg)
    .maybeSingle();

  let polyline = typeof cached?.polyline === "string" ? cached.polyline : null;
  let etaMinutes = num(cached?.duration_min);
  const expired = cached?.expires_at && new Date(cached.expires_at).getTime() < Date.now();
  if ((!polyline || expired) && !terminal) {
    const originLat = leg === "driver_to_pickup" ? driver?.lat : num(trip.pickup_latitude);
    const originLng = leg === "driver_to_pickup" ? driver?.lng : num(trip.pickup_longitude);
    const destLat = leg === "driver_to_pickup" ? num(trip.pickup_latitude) : num(trip.dropoff_latitude);
    const destLng = leg === "driver_to_pickup" ? num(trip.pickup_longitude) : num(trip.dropoff_longitude);
    if (originLat != null && originLng != null && destLat != null && destLng != null) {
      try {
        const route = await getRouteWithCache(
          supabase,
          String(trip.id),
          leg,
          originLat,
          originLng,
          destLat,
          destLng,
          STARTED_STATES.has(status) ? "trip_started" : "trip_assigned",
          false,
        );
        polyline = route.polyline;
        etaMinutes = num(route.duration_min);
      } catch {
        // Cached geometry stays if Google is unavailable. Do not invent a route.
      }
    }
  }
  if (!polyline) return { routeGeoJson: null, etaMinutes };
  const coordinates = decodePolyline(polyline);
  if (coordinates.length < 2) return { routeGeoJson: null, etaMinutes };
  return {
    routeGeoJson: { type: "LineString", coordinates },
    etaMinutes,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const trackingToken =
    (typeof body.tracking_token === "string" && body.tracking_token) ||
    (typeof body.token === "string" && body.token) ||
    "";
  if (!trackingToken) return json({ error: "tracking_token is required" }, 400);

  const verifyToken = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN")?.trim() ?? "";
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")?.trim() ?? "";
  if (!verifyToken || !phoneNumberId) {
    return json({ error: "Tracking unavailable" }, 503);
  }

  const signingMaterial = buildWhatsAppContinuationSigningMaterial({ verifyToken, phoneNumberId });
  let claims = await verifyWhatsAppContinuationToken(trackingToken, signingMaterial);
  // Revolut returns the book token. If that token later expires, the same
  // stored checkout credential may still open its own trip. Signature must
  // still match. An expired token that is not that session is rejected.
  if (!claims) {
    const stale = await verifyWhatsAppContinuationToken(trackingToken, signingMaterial, undefined, {
      allowExpired: true,
    });
    if (stale?.purpose === "book") claims = stale;
  }
  if (!claims) return json({ error: "Invalid or expired tracking link" }, 401);

  let trip = await resolveOwnedTrip(supabase, claims, trackingToken);
  if (!trip) return json({ error: "No live booking found for this link" }, 404);

  const status = String(trip.status ?? "");
  const searchingExpiresMs = trip.searching_expires_at
    ? new Date(String(trip.searching_expires_at)).getTime()
    : null;
  const searchWindowElapsed =
    searchingExpiresMs != null &&
    Number.isFinite(searchingExpiresMs) &&
    Date.now() >= searchingExpiresMs;

  if (SEARCHING_STATES.has(status) && !trip.driver_id && searchWindowElapsed) {
    const tripId = String(trip.id);
    const { data: expiredByServer } = await supabase.rpc(
      "expire_trip_when_search_exhausted",
      { p_trip_id: tripId },
    );
    if (expiredByServer === true) {
      const revolutOrderId = resolveRevolutOrderIdFromTrip(trip);
      if (revolutOrderId) {
        try {
          await releaseRevolutPreauthForTrip(supabase, {
            tripId,
            providerOrderId: revolutOrderId,
            reason: "no_driver_assigned",
            stage: "expire_trip",
            feePence: 0,
          });
        } catch (e) {
          console.warn("[guest-trip-status] Revolut release failed (non-fatal)", e);
        }
      }
      try {
        await notifyWhatsAppNoDriverForTrip(supabase, tripId);
      } catch (e) {
        console.warn("[guest-trip-status] WhatsApp notify failed (non-fatal)", e);
      }
      const refreshed = await loadTrip(supabase, tripId);
      if (refreshed) trip = refreshed;
    }
  }

  const finalStatus = String(trip.status ?? status);
  const searching = SEARCHING_STATES.has(finalStatus) && !trip.driver_id;
  const terminal = TERMINAL_STATES.has(finalStatus);
  const presentation = statusPresentation(finalStatus, searching, terminal);
  const tripCode =
    (typeof trip.trip_number === "string" && trip.trip_number) ||
    (typeof trip.trip_code === "string" && trip.trip_code) ||
    String(trip.id).slice(0, 8).toUpperCase();

  const { data: stopRows } = await supabase
    .from("trip_stops")
    .select("id, type, address, lat, lng, status, stop_index")
    .eq("trip_id", trip.id)
    .order("stop_index", { ascending: true });

  const stops = (stopRows && stopRows.length > 0)
    ? stopRows.map((stop: Record<string, unknown>) => {
      const kindRaw = String(stop.type ?? "").toLowerCase();
      const kind = kindRaw === "pickup" ? "pickup" : kindRaw === "stop" ? "stop" : "destination";
      const stopStatus = String(stop.status ?? "").toLowerCase();
      const state = ["completed", "skipped"].includes(stopStatus)
        ? "completed"
        : stopStatus === "arrived" || stopStatus === "active"
        ? "active"
        : "upcoming";
      const locked = ["completed", "skipped", "arrived"].includes(stopStatus);
      return {
        id: String(stop.id),
        kind,
        sequenceLabel: kind === "stop" ? `Stop ${Number(stop.stop_index) || ""}`.trim() : null,
        label: (stop.address as string) || (kind === "pickup" ? "Pickup" : kind === "destination" ? "Destination" : "Stop"),
        address: (stop.address as string) || null,
        state,
        lat: num(stop.lat),
        lng: num(stop.lng),
        canRemove: kind === "stop" && !locked,
        canEdit: false,
        stopIndex: num(stop.stop_index),
      };
    })
    : [
      {
        id: "pickup",
        kind: "pickup",
        label: (trip.pickup_address as string) || "Pickup",
        address: (trip.pickup_address as string) || null,
        state: searching ? "upcoming" : "active",
        lat: num(trip.pickup_latitude),
        lng: num(trip.pickup_longitude),
        canRemove: false,
        canEdit: false,
      },
      {
        id: "destination",
        kind: "destination",
        label: (trip.dropoff_address as string) || "Destination",
        address: (trip.dropoff_address as string) || null,
        state: "upcoming",
        lat: num(trip.dropoff_latitude),
        lng: num(trip.dropoff_longitude),
        canRemove: false,
        canEdit: false,
      },
    ];

  const nowMs = Date.now();
  const driver = terminal ? null : await driverView(supabase, trip);
  const route = await routeGeometry(supabase, trip, driver, terminal);
  const amount = farePence(trip);
  const activeStop = stops.find((stop) => stop.state === "active" && stop.kind !== "pickup")
    ?? stops.find((stop) => stop.kind === "destination");
  const trackingTokenOut = await createWhatsAppContinuationToken(
    { purpose: "track", waId: claims.waId, tripId: String(trip.id), ttlSeconds: 6 * 60 * 60 },
    signingMaterial,
  );

  return json({
    tripId: trip.id,
    tripCode,
    status: finalStatus,
    statusLabel: presentation.statusLabel,
    statusDetail: presentation.statusDetail,
    searching,
    terminal,
    liveTracking: Boolean(driver?.lat != null && driver?.lng != null) && !terminal,
    searchingExpiresAt: typeof trip.searching_expires_at === "string" ? trip.searching_expires_at : null,
    vehicleLabel: typeof trip.vehicle_type === "string" ? trip.vehicle_type : null,
    stops,
    driver,
    waiting: terminal ? null : waitingView(trip, nowMs),
    fare: amount == null ? null : {
      currencyCode: typeof trip.currency === "string" && trip.currency ? trip.currency : "GBP",
      currentPence: amount,
      paymentStatusLabel: typeof trip.payment_status === "string" ? trip.payment_status.replace(/_/g, " ") : null,
    },
    routeGeoJson: route.routeGeoJson,
    etaMinutes: route.etaMinutes,
    etaLabel: route.etaMinutes != null ? `${Math.max(1, Math.round(route.etaMinutes))} min` : null,
    activeDestinationLabel: activeStop?.label ?? null,
    capabilities: {
      canAddStop: MODIFIABLE_STATUSES.has(finalStatus.toLowerCase()),
      canRemoveStop: MODIFIABLE_STATUSES.has(finalStatus.toLowerCase()),
      canChangeDestination: MODIFIABLE_STATUSES.has(finalStatus.toLowerCase()),
      canEditStop: false,
      canCancel: !terminal,
      cancellationReasons: terminal ? null : [
        { code: "wait-too-long", label: "Wait time is too long" },
        { code: "changed-mind", label: "Changed my mind" },
        { code: "booked-by-mistake", label: "Booked by mistake" },
        { code: "found-another-ride", label: "Found another ride" },
        { code: "other", label: "Other" },
      ],
    },
    trackingToken: trackingTokenOut,
    realtimeChannel: null,
    serverTimeIso: new Date(nowMs).toISOString(),
  });
});
