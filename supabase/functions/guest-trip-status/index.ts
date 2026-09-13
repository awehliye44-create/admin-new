/**
 * guest-trip-status — opaque WhatsApp continuation token → TripView.
 *
 * Public (anon JWT). Access is by signed WhatsApp continuation token only
 * (`?wa=` from book/track links). Never enumerates by MK trip_code.
 *
 * When the trip is past searching_expires_at, applies the existing expire SSOT
 * (RPC + Revolut release + WhatsApp notify) then returns a terminal view.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { corsHeaders } from "../_shared/corsHeaders.ts";
import {
  buildWhatsAppContinuationSigningMaterial,
  verifyWhatsAppContinuationToken,
} from "../_shared/whatsappContinuationToken.ts";
import {
  releaseRevolutPreauthForTrip,
  resolveRevolutOrderIdFromTrip,
} from "../_shared/revolutPreauthReleaseSSOT.ts";
import { notifyWhatsAppNoDriverForTrip } from "../_shared/whatsappNoDriverNotify.ts";

function normalizeWhatsAppWaId(waId: string): string {
  return String(waId ?? "").replace(/\D+/g, "");
}

const SEARCHING_STATES = new Set([
  "pending",
  "searching",
  "offered",
  "broadcasting",
  "offering",
  "searching_new_driver",
]);

const TERMINAL_STATES = new Set([
  "completed",
  "cancelled",
  "canceled",
  "expired",
  "expired_no_driver",
  "no_drivers",
]);

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function phonesLooselyMatch(a: string, b: string): boolean {
  const da = normalizeWhatsAppWaId(a);
  const db = normalizeWhatsAppWaId(b);
  if (!da || !db) return false;
  if (da === db) return true;
  const n = Math.min(10, da.length, db.length);
  return n >= 7 && da.slice(-n) === db.slice(-n);
}

function statusPresentation(status: string, searching: boolean, terminal: boolean) {
  const s = status.toLowerCase();
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
  if (searching) {
    return {
      statusLabel: "Finding your driver",
      statusDetail: "We’re matching nearby ONECAB drivers to your trip.",
    };
  }
  return { statusLabel: status.replace(/_/g, " "), statusDetail: null as string | null };
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

  const claims = await verifyWhatsAppContinuationToken(
    trackingToken,
    buildWhatsAppContinuationSigningMaterial({ verifyToken, phoneNumberId }),
  );
  if (!claims) return json({ error: "Invalid or expired tracking link" }, 401);

  let trip: Record<string, unknown> | null = null;

  if (claims.tripId) {
    const { data } = await supabase
      .from("trips")
      .select(
        "id, trip_number, trip_code, status, driver_id, passenger_phone, booking_source, searching_expires_at, pickup_address, dropoff_address, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, provider_order_id, payment_provider, payment_status, passenger_id, created_at",
      )
      .eq("id", claims.tripId)
      .maybeSingle();
    trip = data;
  }

  if (!trip) {
    const digits = normalizeWhatsAppWaId(claims.waId);
    const phoneSuffix = digits.slice(-10);
    if (phoneSuffix) {
      const { data: rows } = await supabase
        .from("trips")
        .select(
          "id, trip_number, trip_code, status, driver_id, passenger_phone, booking_source, searching_expires_at, pickup_address, dropoff_address, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, provider_order_id, payment_provider, payment_status, passenger_id, created_at",
        )
        .not("passenger_phone", "is", null)
        .ilike("passenger_phone", `%${phoneSuffix}`)
        .order("created_at", { ascending: false })
        .limit(10);

      for (const row of rows ?? []) {
        const phone = typeof row.passenger_phone === "string" ? row.passenger_phone : "";
        if (!phonesLooselyMatch(claims.waId, phone)) continue;
        trip = row;
        break;
      }
    }
  }

  if (!trip) {
    return json({ error: "No live booking found for this link" }, 404);
  }

  const status = String(trip.status ?? "");
  const searchingExpiresMs = trip.searching_expires_at
    ? new Date(String(trip.searching_expires_at)).getTime()
    : null;
  const searchWindowElapsed =
    searchingExpiresMs != null &&
    Number.isFinite(searchingExpiresMs) &&
    Date.now() >= searchingExpiresMs;

  if (
    SEARCHING_STATES.has(status) &&
    !trip.driver_id &&
    searchWindowElapsed
  ) {
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

      const { data: refreshed } = await supabase
        .from("trips")
        .select(
          "id, trip_number, trip_code, status, driver_id, passenger_phone, booking_source, searching_expires_at, pickup_address, dropoff_address, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, provider_order_id, payment_provider, payment_status, passenger_id, created_at",
        )
        .eq("id", tripId)
        .maybeSingle();
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

  const stops = [
    {
      id: "pickup",
      kind: "pickup",
      label: (trip.pickup_address as string) || "Pickup",
      address: (trip.pickup_address as string) || null,
      state: searching || !trip.driver_id ? "upcoming" : "active",
      lat: trip.pickup_lat ?? null,
      lng: trip.pickup_lng ?? null,
    },
    {
      id: "destination",
      kind: "destination",
      label: (trip.dropoff_address as string) || "Destination",
      address: (trip.dropoff_address as string) || null,
      state: "upcoming",
      lat: trip.dropoff_lat ?? null,
      lng: trip.dropoff_lng ?? null,
    },
  ];

  return json({
    tripCode,
    status: finalStatus,
    statusLabel: presentation.statusLabel,
    statusDetail: presentation.statusDetail,
    searching,
    terminal,
    liveTracking: Boolean(trip.driver_id) && !terminal,
    stops,
    driver: null,
    waiting: null,
    fare: null,
    capabilities: {
      canAddStop: false,
      canRemoveStop: false,
      canChangeDestination: false,
      canEditStop: false,
      canCancel: searching,
    },
    realtimeChannel: null,
    serverTimeIso: new Date().toISOString(),
  });
});
