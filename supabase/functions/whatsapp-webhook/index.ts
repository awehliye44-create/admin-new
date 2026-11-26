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
// deno-lint-ignore-file no-explicit-any
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

import { parseWhatsAppWebhookPayload, type WhatsAppInboundMessage } from "../_shared/whatsappInboundParse.ts";
import {
  readWhatsAppHubVerifyQuery,
  verifyWhatsAppHubChallenge,
  verifyWhatsAppWebhookSignature,
} from "./lib/whatsappWebhookVerify.ts";
import { processWhatsAppInboundMessage } from "../_shared/whatsappWorkflow.ts";
import {
  isInboundAttemptsExhausted,
  isInboundSendFailureAction,
  markInboundProcessed,
  recordInboundFailure,
  WHATSAPP_INBOUND_CLAIM_RPC,
  WHATSAPP_INBOUND_MAX_ATTEMPTS,
  WHATSAPP_INBOUND_STALE_CLAIM_SECONDS,
} from "./lib/inboundDurabilitySSOT.ts";

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

type AcceptedInbound = { message: WhatsAppInboundMessage; attemptCount: number };

/** Returns the number of messages that failed and can still be retried by Meta redelivery. */
// deno-lint-ignore no-explicit-any
async function processAcceptedMessages(
  client: SupabaseClient<any>,
  accepted: AcceptedInbound[],
): Promise<{ retryableFailures: number }> {
  let retryableFailures = 0;
  for (const { message, attemptCount } of accepted) {
    const t0 = Date.now();
    let action: string;
    try {
      action = await processWhatsAppInboundMessage(client, message);
    } catch (error) {
      console.error("[whatsapp-webhook] workflow failed", {
        meta_message_id_prefix: message.metaMessageId.slice(0, 24),
        error: String(error),
        attempt_count: attemptCount,
        elapsed_ms: Date.now() - t0,
      });
      await recordInboundFailure(client, message.metaMessageId, attemptCount, error, {
        messageType: message.messageType,
        source: "whatsapp-webhook",
      });
      if (!isInboundAttemptsExhausted(attemptCount)) retryableFailures++;
      continue;
    }
    // P7 M4: a workflow that RETURNS a send-failure action (e.g. `welcome_send_failed`) did not
    // reply to the customer. Treat it exactly like a thrown failure: never mark processed.
    if (isInboundSendFailureAction(action)) {
      console.error("[whatsapp-webhook] workflow send failure", {
        meta_message_id_prefix: message.metaMessageId.slice(0, 24),
        action,
        attempt_count: attemptCount,
        elapsed_ms: Date.now() - t0,
      });
      await recordInboundFailure(
        client,
        message.metaMessageId,
        attemptCount,
        new Error(`send_failed:${action}`),
        { messageType: message.messageType, source: "whatsapp-webhook" },
      );
      if (!isInboundAttemptsExhausted(attemptCount)) retryableFailures++;
      continue;
    }
    const workflowMs = Date.now() - t0;
    // Mark processed after Graph send so customer reply is already in flight.
    await markInboundProcessed(client, message.metaMessageId, action);
    console.info("[whatsapp-webhook] latency", {
      meta_message_id_prefix: message.metaMessageId.slice(0, 24),
      action,
      workflow_ms: workflowMs,
      total_ms: Date.now() - t0,
    });
  }
  return { retryableFailures };
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

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return json(400, { error: "body_read_failed" });
  }
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  if (!supabaseUrl || !serviceKey) {
    console.error("[whatsapp-webhook] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing");
    return json(503, { error: "db_unconfigured" });
  }
  const client = createClient(supabaseUrl, serviceKey);

  const acceptedMessages: AcceptedInbound[] = [];

  for (const message of parsed.messages) {
    const { error } = await client.from("whatsapp_inbound_messages").insert({
      meta_message_id: message.metaMessageId,
      wa_id: message.waId,
      message_type: message.messageType,
      inbound_text: message.textBody,
      phone_number_id: message.phoneNumberId,
      raw_payload: message.valueBlock,
      attempt_count: 1,
      processing_started_at: new Date().toISOString(),
    });
    if (error) {
      if (error.code === "23505") {
        // Duplicate delivery. Only an UNPROCESSED, non-exhausted, non-in-flight row
        // (previous workflow failed or its worker crashed) is re-claimed — atomic CAS.
        const { data: claimRows, error: claimErr } = await client.rpc(
          WHATSAPP_INBOUND_CLAIM_RPC,
          {
            p_meta_message_id: message.metaMessageId,
            p_max_attempts: WHATSAPP_INBOUND_MAX_ATTEMPTS,
            p_stale_after_seconds: WHATSAPP_INBOUND_STALE_CLAIM_SECONDS,
          },
        );
        if (claimErr) {
          console.error("[whatsapp-webhook] retry claim failed", claimErr.message);
          return json(500, { error: "retry_claim_failed" });
        }
        const claimed = Array.isArray(claimRows) ? claimRows[0] : claimRows;
        const attemptCount = Math.round(Number(claimed?.attempt_count ?? 0));
        if (attemptCount > 0) {
          acceptedMessages.push({ message, attemptCount });
        }
        continue;
      }
      console.error("[whatsapp-webhook] dedupe insert failed", error.message);
      return json(500, { error: "dedupe_failed" });
    }
    acceptedMessages.push({ message, attemptCount: 1 });
  }

  if (acceptedMessages.length > 0) {
    // Single-message path (normal Hi / button tap): process BEFORE returning 200 so the
    // Graph send starts immediately and is not deferred to post-response waitUntil.
    // Meta accepts a few seconds of webhook latency; our Hi path targets <3s backend.
    // Multi-message batches stay on waitUntil so we still ACK quickly.
    if (acceptedMessages.length === 1) {
      const { retryableFailures } = await processAcceptedMessages(client, acceptedMessages);
      if (retryableFailures > 0) {
        // Non-2xx → Meta redelivers; the duplicate path re-claims via CAS (attempts capped).
        return json(500, { error: "workflow_failed_retryable" });
      }
    } else {
      scheduleBackground(processAcceptedMessages(client, acceptedMessages));
    }
  }

  return json(200, { ok: true, accepted: acceptedMessages.length });
});
