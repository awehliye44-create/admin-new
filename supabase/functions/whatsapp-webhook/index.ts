/**
 * Meta WhatsApp Cloud API webhook receiver.
 *
 * Secrets (Edge only — never onecab.net frontend):
 * - WHATSAPP_WEBHOOK_VERIFY_TOKEN
 * - WHATSAPP_APP_SECRET (Meta App Secret for X-Hub-Signature-256)
 * - WHATSAPP_ACCESS_TOKEN
 * - WHATSAPP_PHONE_NUMBER_ID
 * - WHATSAPP_BUSINESS_ACCOUNT_ID (validated when present)
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

import { parseWhatsAppWebhookPayload } from "../_shared/whatsappInboundParse.ts";
import {
  readWhatsAppHubVerifyQuery,
  verifyWhatsAppHubChallenge,
  verifyWhatsAppWebhookSignature,
} from "../_shared/whatsappWebhookVerify.ts";
import { processWhatsAppInboundMessage } from "../_shared/whatsappWorkflow.ts";

declare const EdgeRuntime:
  | { waitUntil?: (promise: Promise<unknown>) => void }
  | undefined;

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function scheduleBackground(task: Promise<unknown>): void {
  if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
    EdgeRuntime.waitUntil(task);
    return;
  }
  void task.catch((error) => {
    console.error("[whatsapp-webhook] background task failed", String(error));
  });
}

async function markInboundProcessed(
  client: ReturnType<typeof createClient>,
  metaMessageId: string,
  workflowAction: string,
): Promise<void> {
  await client
    .from("whatsapp_inbound_messages")
    .update({
      processed_at: new Date().toISOString(),
      workflow_action: workflowAction,
    })
    .eq("meta_message_id", metaMessageId);
}

async function processAcceptedMessages(
  client: ReturnType<typeof createClient>,
  metaMessageIds: string[],
): Promise<void> {
  for (const metaMessageId of metaMessageIds) {
    const { data, error } = await client
      .from("whatsapp_inbound_messages")
      .select("meta_message_id, wa_id, message_type, inbound_text, phone_number_id, raw_payload")
      .eq("meta_message_id", metaMessageId)
      .maybeSingle();
    if (error || !data) {
      console.error("[whatsapp-webhook] reload inbound row failed", metaMessageId, error?.message);
      continue;
    }

    const payload = data.raw_payload && typeof data.raw_payload === "object"
      ? data.raw_payload as Record<string, unknown>
      : {};
    const parsed = parseWhatsAppWebhookPayload(payload);
    const message = parsed.messages.find((row) => row.metaMessageId === metaMessageId);
    if (!message) {
      await markInboundProcessed(client, metaMessageId, "parse_miss");
      continue;
    }

    try {
      const action = await processWhatsAppInboundMessage(client, message);
      await markInboundProcessed(client, metaMessageId, action);
    } catch (error) {
      console.error("[whatsapp-webhook] workflow failed", {
        meta_message_id_prefix: metaMessageId.slice(0, 24),
        error: String(error),
      });
      await markInboundProcessed(client, metaMessageId, "workflow_error");
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (req.method === "GET") {
    const verifyToken = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN")?.trim() ?? "";
    if (!verifyToken) {
      console.error("[whatsapp-webhook] WHATSAPP_WEBHOOK_VERIFY_TOKEN missing");
      return text(503, "verify_unconfigured");
    }
    const query = readWhatsAppHubVerifyQuery(new URL(req.url));
    const verified = verifyWhatsAppHubChallenge(query, verifyToken);
    if (!verified.ok) {
      return text(403, "forbidden");
    }
    return text(200, verified.challenge);
  }

  if (req.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  const appSecret = Deno.env.get("WHATSAPP_APP_SECRET")?.trim() ?? "";
  if (!appSecret) {
    console.error("[whatsapp-webhook] WHATSAPP_APP_SECRET missing");
    return json(503, { error: "signature_unconfigured" });
  }

  const rawBody = await req.text();
  const signatureHeader = req.headers.get("X-Hub-Signature-256") ??
    req.headers.get("x-hub-signature-256");

  const signatureOk = await verifyWhatsAppWebhookSignature(rawBody, signatureHeader, appSecret);
  if (!signatureOk) {
    console.warn("[whatsapp-webhook] signature rejected");
    return json(403, { error: "invalid_signature" });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const businessAccountId = Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID")?.trim() ?? "";
  const parsed = parseWhatsAppWebhookPayload(payload);
  if (parsed.objectType && parsed.objectType !== "whatsapp_business_account") {
    return json(200, { ok: true, ignored: true, reason: "unsupported_object" });
  }

  if (businessAccountId && Array.isArray((payload as { entry?: unknown }).entry)) {
    const entries = (payload as { entry: Array<{ id?: string }> }).entry;
    const matchesAccount = entries.some((entry) => String(entry.id ?? "") === businessAccountId);
    if (!matchesAccount) {
      console.info("[whatsapp-webhook] ignored webhook for different WABA");
      return json(200, { ok: true, ignored: true, reason: "waba_mismatch" });
    }
  }

  if (parsed.messages.length === 0) {
    return json(200, { ok: true, ignored: true, reason: "no_inbound_messages" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const client = createClient(supabaseUrl, serviceKey);

  const acceptedIds: string[] = [];
  for (const message of parsed.messages) {
    const { error } = await client.from("whatsapp_inbound_messages").insert({
      meta_message_id: message.metaMessageId,
      wa_id: message.waId,
      message_type: message.messageType,
      inbound_text: message.textBody,
      phone_number_id: message.phoneNumberId,
      raw_payload: payload as Record<string, unknown>,
    });
    if (error) {
      if (error.code === "23505") {
        continue;
      }
      console.error("[whatsapp-webhook] dedupe insert failed", error.message);
      return json(500, { error: "dedupe_failed" });
    }
    acceptedIds.push(message.metaMessageId);
  }

  if (acceptedIds.length > 0) {
    scheduleBackground(processAcceptedMessages(client, acceptedIds));
  }

  return json(200, { ok: true, accepted: acceptedIds.length });
});
