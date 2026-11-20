/**
 * guest-trip-realtime-session — booking-scoped Realtime access for Guest Web.
 *
 * Verifies the opaque WhatsApp tracking token + wa_id ownership, then mints a
 * short-lived passenger Auth JWT so the client can subscribe to the same
 * postgres_changes channels as the native Customer app (RLS passenger-only).
 *
 * Never grants anon SELECT on trip_driver_live_location.
 * Never accepts trip_id without a verified tracking token.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { corsHeaders } from "../_shared/corsHeaders.ts";
import {
  buildWhatsAppContinuationSigningMaterial,
  verifyWhatsAppContinuationToken,
} from "../_shared/whatsappContinuationToken.ts";
import { phonesExactlyMatch } from "../_shared/whatsappGuestBookingSSOT.ts";
import { mintTripPassengerAccessToken } from "../_shared/whatsappPassengerInvoke.ts";

const LIVE_TRACKABLE = new Set([
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

/** Customer App activeTripTrackingConfig parity. */
const RESTORE_POLL_MS = 3_500;
const REALTIME_GPS_STALE_MS = 8_000;
const LOCATION_MAX_STALE_MS = 120_000;

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const token = typeof body.tracking_token === "string" ? body.tracking_token : "";
  if (!token) return json({ error: "tracking_token is required" }, 400);

  const verifyToken = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN")?.trim() ?? "";
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")?.trim() ?? "";
  if (!verifyToken || !phoneNumberId) return json({ error: "Tracking unavailable" }, 503);

  const signing = buildWhatsAppContinuationSigningMaterial({ verifyToken, phoneNumberId });
  let claims = await verifyWhatsAppContinuationToken(token, signing);
  if (!claims) {
    const stale = await verifyWhatsAppContinuationToken(token, signing, undefined, {
      allowExpired: true,
    });
    if (stale?.purpose === "book") claims = stale;
  }
  if (!claims) return json({ error: "Invalid or expired tracking link" }, 401);

  let tripId = claims.tripId || "";
  let trip: Record<string, unknown> | null = null;
  if (tripId) {
    const { data } = await supabase
      .from("trips")
      .select("id, status, passenger_id, payment_session_id, driver_id, confirmed_driver_id")
      .eq("id", tripId)
      .maybeSingle();
    trip = data as Record<string, unknown> | null;
  } else {
    const { data: sessions } = await supabase
      .from("payment_sessions")
      .select("id, trip_id, booking_snapshot")
      .contains("booking_snapshot", { continuation_token: token })
      .limit(3);
    const owned = (sessions ?? []).find((row: { booking_snapshot: unknown }) => {
      const snap = asRecord(row.booking_snapshot);
      return phonesExactlyMatch(typeof snap.wa_id === "string" ? snap.wa_id : "", claims!.waId)
        && String(snap.booking_source ?? "") === "whatsapp_booking";
    });
    if (owned?.trip_id) {
      tripId = String(owned.trip_id);
      const { data } = await supabase
        .from("trips")
        .select("id, status, passenger_id, payment_session_id, driver_id, confirmed_driver_id")
        .eq("id", tripId)
        .maybeSingle();
      trip = data as Record<string, unknown> | null;
    }
  }

  if (!trip?.id || typeof trip.passenger_id !== "string") {
    return json({ error: "No live booking found for this link" }, 404);
  }

  const sessionId = typeof trip.payment_session_id === "string" ? trip.payment_session_id : "";
  const { data: session } = sessionId
    ? await supabase.from("payment_sessions").select("booking_snapshot, trip_id").eq("id", sessionId).maybeSingle()
    : { data: null };
  const snap = asRecord(session?.booking_snapshot);
  if (!phonesExactlyMatch(typeof snap.wa_id === "string" ? snap.wa_id : "", claims.waId)) {
    return json({ error: "Not authorised for this trip" }, 403);
  }
  if (session?.trip_id && session.trip_id !== trip.id) {
    return json({ error: "Not authorised for this trip" }, 403);
  }

  const status = String(trip.status ?? "").toLowerCase();
  if (!LIVE_TRACKABLE.has(status)) {
    return json({
      error: "Live tracking is not available for this trip state",
      code: "not_trackable",
      status,
    }, 400);
  }

  const driverId =
    (typeof trip.confirmed_driver_id === "string" && trip.confirmed_driver_id)
    || (typeof trip.driver_id === "string" && trip.driver_id)
    || "";
  if (!driverId) {
    return json({
      error: "No assigned driver to track yet",
      code: "no_driver",
    }, 409);
  }

  const minted = await mintTripPassengerAccessToken(supabase, trip.passenger_id);
  if (!minted.ok) {
    return json({ error: minted.error }, minted.status);
  }

  return json({
    tripId: trip.id,
    driverId,
    accessToken: minted.accessToken,
    expiresAtIso: minted.expiresAtIso,
    /** Native Customer channel name — postgres_changes on trip_driver_live_location. */
    locationChannel: `customer-driver-loc:${trip.id}:${driverId}`,
    /** Native Customer trip lifecycle channel. */
    tripChannel: `customer-trip:${trip.id}`,
    restorePollIntervalMs: RESTORE_POLL_MS,
    realtimeGpsStaleMs: REALTIME_GPS_STALE_MS,
    locationMaxStaleMs: LOCATION_MAX_STALE_MS,
    /** Poll is recovery only while Realtime GPS is fresh. */
    pollMode: "stale_fallback",
  });
});
