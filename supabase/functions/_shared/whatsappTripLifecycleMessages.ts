/**
 * WhatsApp messages that follow a real trip, not the booking wizard.
 *
 * An abandoned book link may expire. A trip that already exists must not
 * receive "your booking session has expired". Completion sends one thanks.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { phonesExactlyMatch } from "./whatsappGuestBookingSSOT.ts";
import {
  readWhatsAppSendCredentials,
  sendWhatsAppTextMessage,
} from "./whatsappOutbound.ts";

export const WHATSAPP_TRIP_THANKS_MESSAGE =
  "*ONECAB*\nThank you for riding with us.\n\nWe appreciate your trip.";

const ACTIVE_TRIP_STATUSES = new Set([
  "pending",
  "searching",
  "offered",
  "broadcasting",
  "offering",
  "searching_new_driver",
  "confirmed",
  "accepted",
  "driver_assigned",
  "en_route",
  "en_route_to_pickup",
  "driver_en_route",
  "arrived",
  "arrived_at_pickup",
  "driver_arrived",
  "waiting",
  "in_progress",
  "started",
  "on_trip",
  "trip_started",
]);

const TERMINAL_TRIP_STATUSES = new Set([
  "completed",
  "cancelled",
  "canceled",
  "expired",
  "expired_no_driver",
  "no_drivers",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function whatsappTripMessageDecision(status: string | null): "active" | "completed" | "none" {
  const s = String(status ?? "").trim().toLowerCase();
  if (!s) return "none";
  if (s === "completed") return "completed";
  if (ACTIVE_TRIP_STATUSES.has(s)) return "active";
  if (TERMINAL_TRIP_STATUSES.has(s)) return "none";
  return "active";
}

async function tripForWaId(
  client: SupabaseClient,
  waId: string,
): Promise<{ id: string; status: string } | null> {
  const digits = String(waId ?? "").replace(/\D/g, "");
  if (!digits) return null;
  const { data: sessions } = await client
    .from("payment_sessions")
    .select("trip_id, booking_snapshot, created_at")
    .contains("booking_snapshot", { wa_id: digits, booking_source: "whatsapp_booking" })
    .order("created_at", { ascending: false })
    .limit(3);

  for (const row of sessions ?? []) {
    const snap = asRecord(row.booking_snapshot);
    const snapWa = typeof snap.wa_id === "string" ? snap.wa_id : "";
    if (!phonesExactlyMatch(snapWa, waId)) continue;
    const tripId = typeof row.trip_id === "string" ? row.trip_id : "";
    if (!tripId) continue;
    const { data: trip } = await client
      .from("trips")
      .select("id, status")
      .eq("id", tripId)
      .maybeSingle();
    if (!trip?.id) continue;
    return { id: String(trip.id), status: String(trip.status ?? "") };
  }
  return null;
}

/** Close the booking wizard once the trip exists, so the expiry sweep cannot claim it. */
export async function bindWhatsAppConversationToCreatedTrip(
  client: SupabaseClient,
  waId: string,
  tripId: string,
): Promise<void> {
  const digits = String(waId ?? "").replace(/\D/g, "");
  if (!digits || !tripId) return;
  const nowIso = new Date().toISOString();
  const { error } = await client
    .from("whatsapp_conversations")
    .update({
      workflow_state: "track",
      active_trip_id: tripId,
      booking_session_started_at: null,
      booking_session_expires_at: null,
      updated_at: nowIso,
    })
    .eq("wa_id", digits);
  if (error) {
    console.warn("[whatsapp-trip] bind conversation failed", digits.slice(-6));
  }
}

export async function notifyWhatsAppTripCompleted(
  client: SupabaseClient,
  tripId: string,
): Promise<"sent" | "skipped" | "failed"> {
  const { data: trip } = await client
    .from("trips")
    .select("id, status, booking_source, payment_session_id")
    .eq("id", tripId)
    .maybeSingle();
  if (!trip || String(trip.booking_source ?? "") !== "whatsapp_booking") return "skipped";
  if (String(trip.status ?? "").toLowerCase() !== "completed") return "skipped";

  const sessionId = typeof trip.payment_session_id === "string" ? trip.payment_session_id : "";
  if (!sessionId) return "skipped";
  const { data: session } = await client
    .from("payment_sessions")
    .select("booking_snapshot")
    .eq("id", sessionId)
    .maybeSingle();
  const waId = String(asRecord(session?.booking_snapshot).wa_id ?? "").replace(/\D/g, "");
  if (!waId) return "skipped";

  const { data: conversation } = await client
    .from("whatsapp_conversations")
    .select("metadata")
    .eq("wa_id", waId)
    .maybeSingle();
  const metadata = asRecord(conversation?.metadata);
  if (metadata.thanks_trip_id === tripId) return "skipped";

  const creds = readWhatsAppSendCredentials();
  if (!creds) return "failed";
  const sent = await sendWhatsAppTextMessage(creds, waId, WHATSAPP_TRIP_THANKS_MESSAGE);
  const nowIso = new Date().toISOString();
  await client
    .from("whatsapp_conversations")
    .update({
      workflow_state: "idle",
      active_trip_id: null,
      booking_session_started_at: null,
      booking_session_expires_at: null,
      metadata: { ...metadata, thanks_trip_id: tripId },
      last_outbound_at: nowIso,
      updated_at: nowIso,
    })
    .eq("wa_id", waId);
  return sent.ok ? "sent" : "failed";
}

export async function whatsappExpiryActionForWa(
  client: SupabaseClient,
  waId: string,
): Promise<"expire" | "hold_active" | "thank"> {
  const trip = await tripForWaId(client, waId);
  const decision = whatsappTripMessageDecision(trip?.status ?? null);
  if (decision === "active" && trip) {
    await bindWhatsAppConversationToCreatedTrip(client, waId, trip.id);
    return "hold_active";
  }
  if (decision === "completed" && trip) {
    await notifyWhatsAppTripCompleted(client, trip.id);
    return "thank";
  }
  return "expire";
}
