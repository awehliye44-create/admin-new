/**
 * ONECAB WhatsApp customer workflow — welcome once, route book/track/support.
 *
 * Support bridge: when customer selects Customer Support, one support_conversations
 * row (channel='whatsapp') is created/reused and linked via
 * whatsapp_conversations.support_conversation_id. Subsequent support messages
 * are silently bridged into support_messages. No automated follow-up is sent
 * while support is open — human agent owns the conversation.
 *
 * Booking session: 3-minute inactivity TTL. Explicit intent transitions
 * (cancel/menu/track/support/start-again) escape immediately. Expiry sends
 * one notification and resets to idle; it does NOT touch real trips.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

import {
  buildWhatsAppContinuationSigningMaterial,
  buildWhatsAppContinuationUrl,
  createWhatsAppContinuationToken,
} from "./whatsappContinuationToken.ts";
import type { WhatsAppInboundMessage } from "./whatsappInboundParse.ts";
import {
  readWhatsAppSendCredentials,
  sendWhatsAppCompactMenuHint,
  sendWhatsAppTextMessage,
  sendWhatsAppWelcomeMenu,
} from "./whatsappOutbound.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Statuses where the customer has a driver actively in motion or on-trip.
 * Narrower than the invoice-gate status set (which covers pre-driver states like
 * searching/broadcasting that are useless to track). We only want trips where a
 * driver position is meaningful to show the customer.
 */
const TRACKABLE_TRIP_STATUSES = new Set([
  "confirmed",
  "accepted",
  "driver_assigned",
  "en_route",
  "en_route_to_pickup",
  "driver_en_route",
  "driver_arriving",
  "arrived",
  "arrived_pickup",
  "arrived_at_pickup",
  "at_pickup",
  "pickup_waiting",
  "waiting",
  "in_progress",
  "on_trip",
  "started",
  "completing",
]);

/** 3-minute inactivity TTL for booking sessions (seconds). */
const BOOKING_SESSION_TTL_SECONDS = 180;

const SUPPORT_ACK =
  "Thanks — your message is with ONECAB Customer Support. A team member will reply here as soon as possible.";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type WhatsAppWorkflowState = "new" | "idle" | "book" | "track" | "support";

export type WhatsAppWorkflowIntent =
  | "book"
  | "track"
  | "support"
  | "menu"
  | "cancel"
  | "unknown";

type ConversationRow = {
  wa_id: string;
  display_name: string | null;
  workflow_state: WhatsAppWorkflowState;
  welcome_sent_at: string | null;
  support_opened_at: string | null;
  support_conversation_id: string | null;
  active_trip_id: string | null;
  booking_session_expires_at: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Intent resolver
// ─────────────────────────────────────────────────────────────────────────────

export function resolveWhatsAppWorkflowIntent(input: {
  textBody: string | null;
  interactiveId: string | null;
}): WhatsAppWorkflowIntent {
  const interactive = (input.interactiveId ?? "").trim().toLowerCase();
  if (interactive === "book_ride") return "book";
  if (interactive === "track_booking") return "track";
  if (interactive === "customer_support") return "support";

  const text = (input.textBody ?? "").trim().toLowerCase();
  if (!text) return "unknown";

  if (/^(cancel|stop|end|abort|quit|exit)\b/.test(text)) return "cancel";
  if (
    /^(1|book(\s+a)?\s*(ride|taxi|cab)?|booking|ride|taxi|cab)\b/.test(text)
  ) {
    return "book";
  }
  if (
    /^(2|track(\s+my)?(\s+booking)?|tracking|where(\s+is)?|eta|driver)\b/.test(
      text,
    )
  ) {
    return "track";
  }
  if (/^(3|support|help|human|agent|person)\b/.test(text)) return "support";
  if (
    /^(menu|hello|hi|hey|start|start\s+again|restart|new|again)\b/.test(text)
  ) {
    return "menu";
  }
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeWhatsAppWaId(waId: string): string {
  return waId.replace(/\D/g, "");
}

function phoneTail(digits: string): string {
  return digits.slice(-10);
}

function phonesLooselyMatch(a: string, b: string): boolean {
  const da = normalizeWhatsAppWaId(a);
  const db = normalizeWhatsAppWaId(b);
  if (!da || !db) return false;
  return da === db || phoneTail(da) === phoneTail(db);
}

function isTrackableTripStatus(status: string): boolean {
  return TRACKABLE_TRIP_STATUSES.has(status.trim().toLowerCase());
}

export function shouldSendWhatsAppWelcome(conversation: ConversationRow): boolean {
  return conversation.workflow_state === "new" && conversation.welcome_sent_at == null;
}

export function readWhatsAppPublicOrigin(): string {
  return (Deno.env.get("ONECAB_PUBLIC_ORIGIN") ?? "https://onecab.net").replace(
    /\/+$/,
    "",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Trip / customer lookups
// ─────────────────────────────────────────────────────────────────────────────

async function findActiveTripForWaId(
  client: SupabaseClient,
  waId: string,
): Promise<{ id: string; trip_number: string | null; status: string } | null> {
  const digits = normalizeWhatsAppWaId(waId);
  if (!digits) return null;
  const phoneSuffix = digits.slice(-10);

  const { data, error } = await client
    .from("trips")
    .select("id, trip_number, status, passenger_phone, created_at")
    .not("passenger_phone", "is", null)
    .ilike("passenger_phone", `%${phoneSuffix}`)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.error("[whatsapp-webhook] active trip lookup failed", error.message);
    return null;
  }

  for (const row of data ?? []) {
    const phone = typeof row.passenger_phone === "string" ? row.passenger_phone : "";
    const status = typeof row.status === "string" ? row.status : "";
    if (!phonesLooselyMatch(waId, phone)) continue;
    if (!isTrackableTripStatus(status)) continue;
    return {
      id: String(row.id),
      trip_number: typeof row.trip_number === "string" ? row.trip_number : null,
      status,
    };
  }
  return null;
}

/**
 * Resolve ONECAB customer_id from wa_id by matching normalized phone suffix.
 * Returns null for guests with no registered ONECAB account — never throws.
 */
async function resolveCustomerIdForWaId(
  client: SupabaseClient,
  waId: string,
): Promise<string | null> {
  const digits = normalizeWhatsAppWaId(waId);
  if (!digits) return null;
  const phoneSuffix = digits.slice(-10);

  const { data, error } = await client
    .from("customers")
    .select("id, phone")
    .ilike("phone", `%${phoneSuffix}`)
    .limit(5);

  if (error) return null;

  for (const row of data ?? []) {
    const phone = typeof row.phone === "string" ? row.phone : "";
    if (phonesLooselyMatch(waId, phone)) return String(row.id);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation state helpers
// ─────────────────────────────────────────────────────────────────────────────

async function upsertConversationTouch(
  client: SupabaseClient,
  message: WhatsAppInboundMessage,
): Promise<ConversationRow> {
  const nowIso = new Date().toISOString();

  const touchPatch: Record<string, unknown> = {
    wa_id: message.waId,
    last_inbound_at: nowIso,
    updated_at: nowIso,
  };
  if (message.displayName) touchPatch.display_name = message.displayName;

  const { data: upserted, error } = await client
    .from("whatsapp_conversations")
    .upsert(touchPatch, { onConflict: "wa_id", ignoreDuplicates: false })
    .select(
      "wa_id, display_name, workflow_state, welcome_sent_at, support_opened_at, support_conversation_id, active_trip_id, booking_session_expires_at",
    )
    .single();

  if (error || !upserted) {
    const { data: fallback, error: readError } = await client
      .from("whatsapp_conversations")
      .select(
        "wa_id, display_name, workflow_state, welcome_sent_at, support_opened_at, support_conversation_id, active_trip_id, booking_session_expires_at",
      )
      .eq("wa_id", message.waId)
      .single();
    if (readError || !fallback) {
      throw new Error(
        `conversation_upsert_failed:${error?.message ?? readError?.message ?? "unknown"}`,
      );
    }
    return fallback as ConversationRow;
  }

  return upserted as ConversationRow;
}

async function markConversationOutbound(
  client: SupabaseClient,
  waId: string,
  patch: Partial<{
    workflow_state: WhatsAppWorkflowState;
    welcome_sent_at: string;
    support_opened_at: string | null;
    support_conversation_id: string | null;
    active_trip_id: string | null;
    booking_session_started_at: string | null;
    booking_session_expires_at: string | null;
  }>,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await client
    .from("whatsapp_conversations")
    .update({ ...patch, last_outbound_at: nowIso, updated_at: nowIso })
    .eq("wa_id", waId);
  if (error) {
    console.error("[whatsapp-webhook] markConversationOutbound failed", {
      wa_id_suffix: waId.slice(-6),
      patch_keys: Object.keys(patch),
      error: error.message,
    });
  }
}

/** Silently update inbound-side fields (no outbound change). */
async function touchConversationInbound(
  client: SupabaseClient,
  waId: string,
  patch: Partial<{
    booking_session_expires_at: string;
  }>,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await client
    .from("whatsapp_conversations")
    .update({ ...patch, updated_at: nowIso })
    .eq("wa_id", waId);
  if (error) {
    console.error("[whatsapp-webhook] touchConversationInbound failed", {
      wa_id_suffix: waId.slice(-6),
      error: error.message,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Support bridge helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve or create ONE support_conversations row for this WhatsApp contact.
 * Reuses an existing open 'whatsapp' conversation if already linked.
 */
async function ensureSupportConversation(
  client: SupabaseClient,
  waId: string,
  existingConvId: string | null,
  displayName: string | null,
): Promise<string | null> {
  // 1. Reuse if already linked and still open.
  if (existingConvId) {
    const { data: existing } = await client
      .from("support_conversations")
      .select("id, status")
      .eq("id", existingConvId)
      .single();
    if (existing && existing.status !== "resolved" && existing.status !== "closed") {
      return existingConvId;
    }
  }

  // 2. Check for any open whatsapp conversation for this wa_id (avoids duplicates
  //    if whatsapp_conversations.support_conversation_id got out of sync).
  const { data: openConvs } = await client
    .from("support_conversations")
    .select("id, status")
    .eq("wa_id", waId)
    .eq("channel", "whatsapp")
    .not("status", "in", '("resolved","closed")')
    .order("created_at", { ascending: false })
    .limit(1);

  if (openConvs && openConvs.length > 0) return openConvs[0].id;

  // 3. Resolve customer_id (may be null for guests).
  const customerId = await resolveCustomerIdForWaId(client, waId);
  const displayOrWa = displayName ?? `WhatsApp +${waId}`;

  // 4. Create new support conversation.
  const { data: created, error } = await client
    .from("support_conversations")
    .insert({
      subject: `WhatsApp support — ${displayOrWa}`,
      channel: "whatsapp",
      user_type: "customer",
      initiated_by: "user",
      wa_id: waId,
      customer_id: customerId ?? null,
    })
    .select("id")
    .single();

  if (error || !created) {
    console.error("[whatsapp-webhook] ensureSupportConversation failed", error?.message);
    return null;
  }

  return created.id;
}

/**
 * Bridge an inbound WhatsApp message into support_messages.
 * Also updates support_conversations.last_message_at so the Admin inbox
 * shows the correct last-activity time.
 */
async function bridgeToSupportMessages(
  client: SupabaseClient,
  supportConvId: string,
  waId: string,
  content: string,
  receivedAt: string,
): Promise<void> {
  const { error } = await client.from("support_messages").insert({
    conversation_id: supportConvId,
    sender_type: "customer",
    sender_id: null,
    content: content || "(no text)",
    content_type: "text",
    is_read: false,
    metadata: { wa_id_suffix: waId.slice(-6), received_at: receivedAt },
  });

  if (error) {
    console.error("[whatsapp-webhook] bridgeToSupportMessages failed", error.message);
    return;
  }

  // Update last_message_at on the conversation so the Admin list re-sorts.
  await client
    .from("support_conversations")
    .update({ last_message_at: receivedAt, updated_at: new Date().toISOString() })
    .eq("id", supportConvId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Booking continuation
// ─────────────────────────────────────────────────────────────────────────────

function bookingExpiresAt(): string {
  return new Date(Date.now() + BOOKING_SESSION_TTL_SECONDS * 1000).toISOString();
}

async function sendBookContinuation(
  client: SupabaseClient,
  waId: string,
  creds: NonNullable<ReturnType<typeof readWhatsAppSendCredentials>>,
): Promise<string> {
  const verifyToken = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN")?.trim() ?? "";
  if (!verifyToken) {
    console.warn(
      "[whatsapp-webhook] WHATSAPP_WEBHOOK_VERIFY_TOKEN missing — continuation token signing is degraded",
    );
  }
  const signingMaterial = buildWhatsAppContinuationSigningMaterial({
    verifyToken,
    phoneNumberId: creds.phoneNumberId,
  });
  const token = await createWhatsAppContinuationToken(
    { purpose: "book", waId, tripId: null, ttlSeconds: 7200 },
    signingMaterial,
  );
  const url = buildWhatsAppContinuationUrl(readWhatsAppPublicOrigin(), "book", token);
  const sent = await sendWhatsAppTextMessage(
    creds,
    waId,
    `Book your ONECAB ride here:\n${url}\n\nThis secure link continues your WhatsApp booking.`,
    { previewUrl: true },
  );
  if (!sent.ok) return "book_link_send_failed";

  const nowIso = new Date().toISOString();
  await markConversationOutbound(client, waId, {
    workflow_state: "book",
    booking_session_started_at: nowIso,
    booking_session_expires_at: bookingExpiresAt(),
  });
  return "book_link_sent";
}

// ─────────────────────────────────────────────────────────────────────────────
// Track continuation
// ─────────────────────────────────────────────────────────────────────────────

async function sendTrackContinuation(
  client: SupabaseClient,
  waId: string,
  creds: NonNullable<ReturnType<typeof readWhatsAppSendCredentials>>,
): Promise<string> {
  const activeTrip = await findActiveTripForWaId(client, waId);
  const verifyToken = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN")?.trim() ?? "";
  if (!verifyToken) {
    console.warn(
      "[whatsapp-webhook] WHATSAPP_WEBHOOK_VERIFY_TOKEN missing — continuation token signing is degraded",
    );
  }
  const signingMaterial = buildWhatsAppContinuationSigningMaterial({
    verifyToken,
    phoneNumberId: creds.phoneNumberId,
  });
  const token = await createWhatsAppContinuationToken(
    { purpose: "track", waId, tripId: activeTrip?.id ?? null, ttlSeconds: 3600 },
    signingMaterial,
  );
  const url = buildWhatsAppContinuationUrl(readWhatsAppPublicOrigin(), "track", token);

  let trackSent;
  if (activeTrip) {
    const ref = activeTrip.trip_number ? ` (${activeTrip.trip_number})` : "";
    trackSent = await sendWhatsAppTextMessage(
      creds,
      waId,
      `Track your live ONECAB booking${ref} here:\n${url}\n\nThis secure link opens live tracking.`,
      { previewUrl: true },
    );
  } else {
    trackSent = await sendWhatsAppTextMessage(
      creds,
      waId,
      `Open secure ONECAB tracking here:\n${url}\n\nIf you do not see your booking, reply with your booking reference and our team will help.`,
      { previewUrl: true },
    );
  }
  if (!trackSent.ok) return "track_link_send_failed";

  await markConversationOutbound(client, waId, {
    workflow_state: "track",
    active_trip_id: activeTrip?.id ?? null,
  });
  return activeTrip ? "track_link_active_trip" : "track_link_generic";
}

// ─────────────────────────────────────────────────────────────────────────────
// Support open / bridge
// ─────────────────────────────────────────────────────────────────────────────

async function openSupportState(
  client: SupabaseClient,
  waId: string,
  creds: NonNullable<ReturnType<typeof readWhatsAppSendCredentials>>,
  conversation: ConversationRow,
  inboundText: string | null,
  receivedAt: string,
): Promise<string> {
  const alreadyOpen =
    conversation.workflow_state === "support" &&
    conversation.support_conversation_id != null;

  const supportConvId = await ensureSupportConversation(
    client,
    waId,
    conversation.support_conversation_id,
    conversation.display_name,
  );

  if (!alreadyOpen) {
    // Send acknowledgement ONCE — only on first open.
    const sent = await sendWhatsAppTextMessage(creds, waId, SUPPORT_ACK);
    if (!sent.ok) return "support_send_failed";

    const nowIso = new Date().toISOString();
    await markConversationOutbound(client, waId, {
      workflow_state: "support",
      support_opened_at: nowIso,
      support_conversation_id: supportConvId,
    });
  } else {
    // Support already open: just update the link (no outbound message to customer).
    if (supportConvId && supportConvId !== conversation.support_conversation_id) {
      await markConversationOutbound(client, waId, {
        support_conversation_id: supportConvId,
      });
    }
  }

  // Bridge this inbound message into support_messages so Admin can see it.
  if (supportConvId) {
    await bridgeToSupportMessages(
      client,
      supportConvId,
      waId,
      inboundText ?? "(message)",
      receivedAt,
    );
  }

  return alreadyOpen ? "support_message_bridged" : "support_opened";
}

// ─────────────────────────────────────────────────────────────────────────────
// Booking cancel / reset helpers
// ─────────────────────────────────────────────────────────────────────────────

async function cancelBookingSession(
  client: SupabaseClient,
  waId: string,
  creds: NonNullable<ReturnType<typeof readWhatsAppSendCredentials>>,
): Promise<string> {
  const sent = await sendWhatsAppCompactMenuHint(creds, waId);
  await markConversationOutbound(client, waId, {
    workflow_state: "idle",
    booking_session_started_at: null,
    booking_session_expires_at: null,
  });
  return sent.ok ? "booking_cancelled_menu" : "booking_cancelled";
}

// ─────────────────────────────────────────────────────────────────────────────
// Main orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export async function processWhatsAppInboundMessage(
  client: SupabaseClient,
  message: WhatsAppInboundMessage,
): Promise<string> {
  const creds = readWhatsAppSendCredentials();
  if (!creds) {
    console.error("[whatsapp-webhook] outbound credentials missing");
    return "outbound_unconfigured";
  }

  const conversation = await upsertConversationTouch(client, message);
  const receivedAt = new Date().toISOString();

  // ── 1. Welcome (first ever message from this contact)
  if (shouldSendWhatsAppWelcome(conversation)) {
    const sent = await sendWhatsAppWelcomeMenu(creds, message.waId);
    if (!sent.ok) return "welcome_send_failed";
    await markConversationOutbound(client, message.waId, {
      workflow_state: "idle",
      welcome_sent_at: new Date().toISOString(),
    });

    const firstIntent = resolveWhatsAppWorkflowIntent({
      textBody: message.textBody,
      interactiveId: message.interactiveId,
    });
    if (firstIntent === "book") {
      const followUp = await sendBookContinuation(client, message.waId, creds);
      return `welcome_sent:${followUp}`;
    }
    if (firstIntent === "track") {
      const followUp = await sendTrackContinuation(client, message.waId, creds);
      return `welcome_sent:${followUp}`;
    }
    if (firstIntent === "support") {
      const followUp = await openSupportState(
        client,
        message.waId,
        creds,
        conversation,
        message.textBody,
        receivedAt,
      );
      return `welcome_sent:${followUp}`;
    }
    return "welcome_sent";
  }

  const intent = resolveWhatsAppWorkflowIntent({
    textBody: message.textBody,
    interactiveId: message.interactiveId,
  });

  // ── 2. Support state: human agent owns the conversation.
  //       book/track/cancel exit support; everything else is silently bridged.
  if (conversation.workflow_state === "support") {
    if (intent === "book") return sendBookContinuation(client, message.waId, creds);
    if (intent === "track") return sendTrackContinuation(client, message.waId, creds);
    if (intent === "cancel" || intent === "menu") {
      // Customer explicitly wants to leave support — let them.
      await markConversationOutbound(client, message.waId, {
        workflow_state: "idle",
        support_opened_at: null,
        support_conversation_id: null,
      });
      const sent = await sendWhatsAppCompactMenuHint(creds, message.waId);
      return sent.ok ? "support_exited_menu" : "support_exited";
    }
    // Everything else: bridge silently, no automated reply.
    return openSupportState(
      client,
      message.waId,
      creds,
      conversation,
      message.textBody,
      receivedAt,
    );
  }

  // ── 3. Book state: refresh TTL on any booking-related interaction,
  //       or escape on explicit intents.
  if (conversation.workflow_state === "book") {
    if (intent === "cancel" || intent === "menu") {
      return cancelBookingSession(client, message.waId, creds);
    }
    if (intent === "track") return sendTrackContinuation(client, message.waId, creds);
    if (intent === "support") {
      return openSupportState(
        client,
        message.waId,
        creds,
        conversation,
        message.textBody,
        receivedAt,
      );
    }
    if (intent === "book") {
      // Re-send book link and refresh TTL.
      return sendBookContinuation(client, message.waId, creds);
    }
    // Unknown text during booking: refresh TTL, resend link.
    await touchConversationInbound(client, message.waId, {
      booking_session_expires_at: bookingExpiresAt(),
    });
    return sendBookContinuation(client, message.waId, creds);
  }

  // ── 4. Standard state machine (idle / track / new-post-welcome).
  switch (intent) {
    case "book":
      return sendBookContinuation(client, message.waId, creds);
    case "track":
      return sendTrackContinuation(client, message.waId, creds);
    case "support":
      return openSupportState(
        client,
        message.waId,
        creds,
        conversation,
        message.textBody,
        receivedAt,
      );
    case "cancel":
    case "menu": {
      const menuSent = await sendWhatsAppCompactMenuHint(creds, message.waId);
      if (!menuSent.ok) return "menu_hint_send_failed";
      await markConversationOutbound(client, message.waId, { workflow_state: "idle" });
      return "menu_hint_sent";
    }
    default:
      if (conversation.workflow_state === "track") {
        return sendTrackContinuation(client, message.waId, creds);
      }
      {
        const unknownSent = await sendWhatsAppCompactMenuHint(creds, message.waId);
        if (!unknownSent.ok) return "unknown_menu_hint_send_failed";
      }
      return "unknown_menu_hint";
  }
}
