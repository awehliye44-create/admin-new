/**
 * Thin WhatsApp no-driver / search-exhausted notification bridge.
 *
 * Consumes the existing trip terminal outcome only — does not invent a second
 * search timeout or alter Revolut / trip financial state.
 *
 * Idempotent via trips.no_driver_customer_alert_sent_at claim.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  readWhatsAppSendCredentials,
  sendWhatsAppTextMessage,
} from "./whatsappOutbound.ts";

export const WHATSAPP_NO_DRIVER_MESSAGE =
  "*ONECAB*\n\nSorry, no drivers are available for your journey right now.\n\nPlease try again.";

const WHATSAPP_BOOKING_SOURCES = new Set([
  "whatsapp_booking",
  "whatsapp-booking",
  "whatsapp",
]);

function normalizeWhatsAppWaId(waId: string): string {
  return String(waId ?? "").replace(/\D+/g, "");
}

function phonesLooselyMatch(a: string, b: string): boolean {
  const da = normalizeWhatsAppWaId(a);
  const db = normalizeWhatsAppWaId(b);
  if (!da || !db) return false;
  if (da === db) return true;
  const n = Math.min(10, da.length, db.length);
  return n >= 7 && da.slice(-n) === db.slice(-n);
}

function isWhatsAppBookingSource(source: unknown): boolean {
  if (typeof source !== "string") return false;
  const normalized = source.trim().toLowerCase();
  if (WHATSAPP_BOOKING_SOURCES.has(normalized)) return true;
  return normalized.includes("whatsapp");
}

async function resolveWaIdForTrip(
  client: SupabaseClient,
  trip: {
    id: string;
    passenger_phone?: string | null;
  },
): Promise<string | null> {
  const { data: byActive } = await client
    .from("whatsapp_conversations")
    .select("wa_id")
    .eq("active_trip_id", trip.id)
    .limit(1)
    .maybeSingle();
  if (typeof byActive?.wa_id === "string" && byActive.wa_id.trim()) {
    return byActive.wa_id.trim();
  }

  // Prefer wa_id stamped on the payment session booking snapshot.
  const { data: session } = await client
    .from("payment_sessions")
    .select("booking_snapshot, metadata")
    .eq("trip_id", trip.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const snap = (session?.booking_snapshot ?? {}) as Record<string, unknown>;
  const meta = (session?.metadata ?? {}) as Record<string, unknown>;
  const stamped =
    (typeof snap.wa_id === "string" && snap.wa_id) ||
    (typeof meta.wa_id === "string" && meta.wa_id) ||
    null;
  if (stamped) return stamped;

  const phone = typeof trip.passenger_phone === "string" ? trip.passenger_phone : "";
  const digits = normalizeWhatsAppWaId(phone);
  if (!digits) return null;
  const phoneSuffix = digits.slice(-10);

  const { data: rows } = await client
    .from("whatsapp_conversations")
    .select("wa_id")
    .ilike("wa_id", `%${phoneSuffix}`)
    .limit(10);

  for (const row of rows ?? []) {
    const waId = typeof row.wa_id === "string" ? row.wa_id : "";
    if (phonesLooselyMatch(waId, phone)) return waId;
  }
  return null;
}

export type WhatsAppNoDriverNotifyResult =
  | { status: "skipped_not_whatsapp" }
  | { status: "skipped_already_notified" }
  | { status: "skipped_no_wa_id" }
  | { status: "notified"; wa_id_suffix: string }
  | { status: "notify_failed"; wa_id_suffix: string; error: string }
  | { status: "outbound_unconfigured" };

/**
 * Send exactly one no-driver WhatsApp message for a whatsapp_booking trip,
 * then reset transient booking workflow to idle.
 */
export async function notifyWhatsAppNoDriverForTrip(
  client: SupabaseClient,
  tripId: string,
): Promise<WhatsAppNoDriverNotifyResult> {
  const { data: trip, error } = await client
    .from("trips")
    .select(
      "id, booking_source, passenger_phone, status, no_driver_customer_alert_sent_at",
    )
    .eq("id", tripId)
    .maybeSingle();

  if (error || !trip) {
    console.warn("[whatsapp-no-driver] trip lookup failed", tripId, error?.message);
    return { status: "skipped_not_whatsapp" };
  }

  if (!isWhatsAppBookingSource(trip.booking_source)) {
    return { status: "skipped_not_whatsapp" };
  }

  if (trip.no_driver_customer_alert_sent_at) {
    return { status: "skipped_already_notified" };
  }

  const nowIso = new Date().toISOString();
  const { data: claimed, error: claimErr } = await client
    .from("trips")
    .update({ no_driver_customer_alert_sent_at: nowIso })
    .eq("id", tripId)
    .is("no_driver_customer_alert_sent_at", null)
    .select("id")
    .maybeSingle();

  if (claimErr || !claimed) {
    return { status: "skipped_already_notified" };
  }

  const waId = await resolveWaIdForTrip(client, trip);
  if (!waId) {
    console.warn("[whatsapp-no-driver] no wa_id for trip", tripId.slice(0, 8));
    return { status: "skipped_no_wa_id" };
  }

  const creds = readWhatsAppSendCredentials();
  if (!creds) return { status: "outbound_unconfigured" };

  const sent = await sendWhatsAppTextMessage(creds, waId, WHATSAPP_NO_DRIVER_MESSAGE);

  await client
    .from("whatsapp_conversations")
    .update({
      workflow_state: "idle",
      booking_session_started_at: null,
      booking_session_expires_at: null,
      active_trip_id: null,
      updated_at: nowIso,
    })
    .eq("wa_id", waId);

  if (!sent.ok) {
    console.error("[whatsapp-no-driver] send failed", {
      trip_id: tripId,
      wa_id_suffix: waId.slice(-6),
      status: sent.status,
    });
    return {
      status: "notify_failed",
      wa_id_suffix: waId.slice(-6),
      error: sent.error,
    };
  }

  return { status: "notified", wa_id_suffix: waId.slice(-6) };
}
