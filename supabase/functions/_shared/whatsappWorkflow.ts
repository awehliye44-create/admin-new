/**
 * ONECAB WhatsApp customer workflow — welcome once, route book/track/support.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

import { isActiveTripStatusForInvoice } from "./tripInvoiceEligibility.ts";
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

export type WhatsAppWorkflowState = "new" | "idle" | "book" | "track" | "support";

export type WhatsAppWorkflowIntent =
  | "book"
  | "track"
  | "support"
  | "menu"
  | "unknown";

type ConversationRow = {
  wa_id: string;
  display_name: string | null;
  workflow_state: WhatsAppWorkflowState;
  welcome_sent_at: string | null;
  support_opened_at: string | null;
  active_trip_id: string | null;
};

const SUPPORT_ACK =
  "Thanks — your message is with ONECAB Customer Support. A team member will reply here as soon as possible.";

const SUPPORT_FOLLOW_UP =
  "We still have your support request open. Please send any extra details here and our team will pick this up.";

export function normalizeWhatsAppWaId(waId: string): string {
  return waId.replace(/\D/g, "");
}

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

  if (/^(1|book(\s+a)?\s*(ride|taxi|cab)?|booking|ride|taxi|cab)\b/.test(text)) {
    return "book";
  }
  if (/^(2|track(\s+my)?(\s+booking)?|tracking|where(\s+is)?|eta|driver)\b/.test(text)) {
    return "track";
  }
  if (/^(3|support|help|human|agent|person)\b/.test(text)) {
    return "support";
  }
  if (/^(menu|hello|hi|hey|start)\b/.test(text)) {
    return "menu";
  }
  return "unknown";
}

export function shouldSendWhatsAppWelcome(conversation: ConversationRow): boolean {
  return conversation.workflow_state === "new" && conversation.welcome_sent_at == null;
}

export function readWhatsAppPublicOrigin(): string {
  return (Deno.env.get("ONECAB_PUBLIC_ORIGIN") ?? "https://onecab.net").replace(/\/+$/, "");
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

async function findActiveTripForWaId(
  client: SupabaseClient,
  waId: string,
): Promise<{ id: string; trip_number: string | null; status: string } | null> {
  // Normalise to digits-only for a loose suffix match against stored passenger_phone values.
  const digits = normalizeWhatsAppWaId(waId);
  if (!digits) return null;

  // Query trips where passenger_phone ends with the last 10 digits of the WA number.
  // This handles country-code prefix differences (e.g. 07700900000 vs 447700900000).
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
    if (!isActiveTripStatusForInvoice(status)) continue;
    return {
      id: String(row.id),
      trip_number: typeof row.trip_number === "string" ? row.trip_number : null,
      status,
    };
  }
  return null;
}

async function upsertConversationTouch(
  client: SupabaseClient,
  message: WhatsAppInboundMessage,
): Promise<ConversationRow> {
  const nowIso = new Date().toISOString();

  // Upsert on the primary key: handles concurrent first-message races without
  // a separate read+insert sequence.
  // Only include display_name when non-null — never overwrite a stored name with null.
  const touchPatch: Record<string, unknown> = {
    wa_id: message.waId,
    last_inbound_at: nowIso,
    updated_at: nowIso,
  };
  if (message.displayName) touchPatch.display_name = message.displayName;

  const { data: upserted, error } = await client
    .from("whatsapp_conversations")
    .upsert(touchPatch, {
      onConflict: "wa_id",
      ignoreDuplicates: false,
    })
    .select("wa_id, display_name, workflow_state, welcome_sent_at, support_opened_at, active_trip_id")
    .single();

  if (error || !upserted) {
    // Upsert can still fail for non-conflict reasons — fall back to read.
    const { data: fallback, error: readError } = await client
      .from("whatsapp_conversations")
      .select("wa_id, display_name, workflow_state, welcome_sent_at, support_opened_at, active_trip_id")
      .eq("wa_id", message.waId)
      .single();
    if (readError || !fallback) {
      throw new Error(`conversation_upsert_failed:${error?.message ?? readError?.message ?? "unknown"}`);
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
    support_opened_at: string;
    active_trip_id: string | null;
  }>,
): Promise<void> {
  const nowIso = new Date().toISOString();
  await client
    .from("whatsapp_conversations")
    .update({
      ...patch,
      last_outbound_at: nowIso,
      updated_at: nowIso,
    })
    .eq("wa_id", waId);
}

async function sendBookContinuation(
  client: SupabaseClient,
  waId: string,
  creds: NonNullable<ReturnType<typeof readWhatsAppSendCredentials>>,
): Promise<string> {
  const verifyToken = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN")?.trim() ?? "";
  const signingMaterial = buildWhatsAppContinuationSigningMaterial({
    verifyToken,
    phoneNumberId: creds.phoneNumberId,
  });
  const token = await createWhatsAppContinuationToken(
    { purpose: "book", waId, tripId: null, ttlSeconds: 7200 },
    signingMaterial,
  );
  const url = buildWhatsAppContinuationUrl(readWhatsAppPublicOrigin(), "book", token);
  await sendWhatsAppTextMessage(
    creds,
    waId,
    `Book your ONECAB ride here:\n${url}\n\nThis secure link continues your WhatsApp booking.`,
    { previewUrl: true },
  );
  await markConversationOutbound(client, waId, { workflow_state: "book" });
  return "book_link_sent";
}

async function sendTrackContinuation(
  client: SupabaseClient,
  waId: string,
  creds: NonNullable<ReturnType<typeof readWhatsAppSendCredentials>>,
): Promise<string> {
  const activeTrip = await findActiveTripForWaId(client, waId);
  const verifyToken = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN")?.trim() ?? "";
  const signingMaterial = buildWhatsAppContinuationSigningMaterial({
    verifyToken,
    phoneNumberId: creds.phoneNumberId,
  });
  const token = await createWhatsAppContinuationToken(
    {
      purpose: "track",
      waId,
      tripId: activeTrip?.id ?? null,
      ttlSeconds: 3600,
    },
    signingMaterial,
  );
  const url = buildWhatsAppContinuationUrl(readWhatsAppPublicOrigin(), "track", token);

  if (activeTrip) {
    const ref = activeTrip.trip_number ? ` (${activeTrip.trip_number})` : "";
    await sendWhatsAppTextMessage(
      creds,
      waId,
      `Track your live ONECAB booking${ref} here:\n${url}\n\nThis secure link opens live tracking.`,
      { previewUrl: true },
    );
  } else {
    await sendWhatsAppTextMessage(
      creds,
      waId,
      `Open secure ONECAB tracking here:\n${url}\n\nIf you do not see your booking, reply with your booking reference and our team will help.`,
      { previewUrl: true },
    );
  }

  await markConversationOutbound(client, waId, {
    workflow_state: "track",
    active_trip_id: activeTrip?.id ?? null,
  });
  return activeTrip ? "track_link_active_trip" : "track_link_generic";
}

async function openSupportState(
  client: SupabaseClient,
  waId: string,
  creds: NonNullable<ReturnType<typeof readWhatsAppSendCredentials>>,
  alreadyOpen: boolean,
): Promise<string> {
  await sendWhatsAppTextMessage(creds, waId, alreadyOpen ? SUPPORT_FOLLOW_UP : SUPPORT_ACK);
  await markConversationOutbound(client, waId, {
    workflow_state: "support",
    ...(alreadyOpen ? {} : { support_opened_at: new Date().toISOString() }),
  });
  return alreadyOpen ? "support_follow_up" : "support_opened";
}

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
      const followUp = await openSupportState(client, message.waId, creds, false);
      return `welcome_sent:${followUp}`;
    }
    return "welcome_sent";
  }

  const intent = resolveWhatsAppWorkflowIntent({
    textBody: message.textBody,
    interactiveId: message.interactiveId,
  });

  // While in support state, explicit book/track intents override and exit support.
  // Anything else (including unknown text) extends the support conversation.
  if (conversation.workflow_state === "support") {
    if (intent === "book") return sendBookContinuation(client, message.waId, creds);
    if (intent === "track") return sendTrackContinuation(client, message.waId, creds);
    return openSupportState(client, message.waId, creds, true);
  }

  switch (intent) {
    case "book":
      return sendBookContinuation(client, message.waId, creds);
    case "track":
      return sendTrackContinuation(client, message.waId, creds);
    case "support":
      return openSupportState(client, message.waId, creds, false);
    case "menu":
      await sendWhatsAppCompactMenuHint(creds, message.waId);
      await markConversationOutbound(client, message.waId, { workflow_state: "idle" });
      return "menu_hint_sent";
    default:
      if (conversation.workflow_state === "book") {
        return sendBookContinuation(client, message.waId, creds);
      }
      if (conversation.workflow_state === "track") {
        return sendTrackContinuation(client, message.waId, creds);
      }
      await sendWhatsAppCompactMenuHint(creds, message.waId);
      return "unknown_menu_hint";
  }
}
