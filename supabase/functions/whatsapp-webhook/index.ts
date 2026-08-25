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
import { readWhatsAppSendCredentials } from "../_shared/whatsappOutbound.ts";
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

// deno-lint-ignore no-explicit-any
async function markInboundProcessed(
  client: SupabaseClient<any>,
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

// deno-lint-ignore no-explicit-any
async function processAcceptedMessages(
  client: SupabaseClient<any>,
  messages: WhatsAppInboundMessage[],
): Promise<void> {
  for (const message of messages) {
    try {
      const action = await processWhatsAppInboundMessage(client, message);
      await markInboundProcessed(client, message.metaMessageId, action);
    } catch (error) {
      console.error("[whatsapp-webhook] workflow failed", {
        meta_message_id_prefix: message.metaMessageId.slice(0, 24),
        error: String(error),
      });
      await markInboundProcessed(client, message.metaMessageId, "workflow_error");
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

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return json(400, { error: "body_read_failed" });
  }

  // Service-role ops (acceptance / Meta health) — never used by Meta.
  const supabaseUrlEarly = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const serviceKeyEarly = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  const authHeaderEarly = req.headers.get("Authorization") ?? "";
  const bearerEarly = authHeaderEarly.replace(/^Bearer\s+/i, "").trim();
  let opsAuth = Boolean(serviceKeyEarly && bearerEarly === serviceKeyEarly);
  if (!opsAuth && bearerEarly.split(".").length === 3) {
    try {
      const payload = JSON.parse(atob(bearerEarly.split(".")[1]!));
      if (payload?.role === "service_role") opsAuth = true;
    } catch { /* ignore */ }
  }
  if (opsAuth) {
    try {
      const ops = JSON.parse(rawBody) as Record<string, unknown>;
      if (ops?.action === "meta_health") {
        const accessToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN")?.trim() ?? "";
        const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")?.trim() ?? "";
        const wabaId = Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID")?.trim() ?? "";
        const appSecret = Deno.env.get("WHATSAPP_APP_SECRET")?.trim() ?? "";
        if (!accessToken || !phoneNumberId) {
          return json(503, { error: "whatsapp_unconfigured" });
        }

        const auth = { headers: { Authorization: `Bearer ${accessToken}` } };
        const graph = "https://graph.facebook.com/v21.0";

        // Safe identity fingerprint only (never return raw token).
        const tokenFingerprint = await crypto.subtle
          .digest("SHA-256", new TextEncoder().encode(accessToken))
          .then((buf) =>
            Array.from(new Uint8Array(buf))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("")
              .slice(0, 16)
          );

        const phoneRes = await fetch(
          `${graph}/${phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,name_status,status,code_verification_status,is_official_business_account`,
          auth,
        );
        const appsRes = await fetch(`${graph}/${phoneNumberId}/subscribed_apps`, auth);
        const wabaRes = wabaId
          ? await fetch(
            `${graph}/${wabaId}?fields=id,name,account_review_status,business_verification_status,ownership_type,message_template_namespace`,
            auth,
          )
          : null;
        const meRes = await fetch(`${graph}/me?fields=id,name`, auth);

        // debug_token: prefer app|secret inspector; fall back to self-inspect.
        let debugToken: unknown = null;
        const debugUrl = new URL(`${graph}/debug_token`);
        debugUrl.searchParams.set("input_token", accessToken);
        if (appSecret) {
          // App access token form requires app id; try self-debug first.
          debugUrl.searchParams.set("access_token", accessToken);
        } else {
          debugUrl.searchParams.set("access_token", accessToken);
        }
        const debugRes = await fetch(debugUrl.toString());
        debugToken = await debugRes.json();

        // Redact any accidental token echoes from nested payloads.
        const redact = (value: unknown): unknown => {
          if (typeof value === "string") {
            if (value === accessToken) return "[redacted]";
            if (value.length > 40 && value.includes(accessToken.slice(0, 8))) return "[redacted]";
            return value;
          }
          if (Array.isArray(value)) return value.map(redact);
          if (value && typeof value === "object") {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
              if (/token/i.test(k) && typeof v === "string" && v.length > 20) {
                out[k] = "[redacted]";
              } else {
                out[k] = redact(v);
              }
            }
            return out;
          }
          return value;
        };

        return json(200, {
          ok: true,
          graph_version: "v21.0",
          waba_id: wabaId || null,
          waba_id_suffix: wabaId.slice(-6),
          phone_number_id: phoneNumberId,
          phone_number_id_suffix: phoneNumberId.slice(-6),
          access_token_sha256_prefix: tokenFingerprint,
          phone: redact(await phoneRes.json()),
          subscribed_apps: redact(await appsRes.json()),
          waba: wabaRes ? redact(await wabaRes.json()) : null,
          me: redact(await meRes.json()),
          debug_token: redact(debugToken),
        });
      }
      // Controlled production outbound probe — plain text only, no workflow mutation.
      // Uses the same credentials + Graph messages endpoint as sendWhatsAppTextMessage / whatsapp-reply.
      if (
        ops?.action === "send_text_test" &&
        typeof ops.wa_id === "string" &&
        typeof ops.text === "string"
      ) {
        const creds = readWhatsAppSendCredentials();
        if (!creds) return json(503, { error: "whatsapp_unconfigured" });
        const waId = ops.wa_id.replace(/\D/g, "");
        const textBody = ops.text.trim();
        if (!waId || !textBody) return json(400, { error: "wa_id_and_text_required" });

        const tokenFingerprint = await crypto.subtle
          .digest("SHA-256", new TextEncoder().encode(creds.accessToken))
          .then((buf) =>
            Array.from(new Uint8Array(buf))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("")
              .slice(0, 16)
          );

        const graphEndpoint =
          `https://graph.facebook.com/v21.0/${creds.phoneNumberId}/messages`;
        // Same payload shape as sendWhatsAppTextMessage / whatsapp-reply (one send only).
        const response = await fetch(graphEndpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${creds.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: waId,
            type: "text",
            text: { preview_url: false, body: textBody },
          }),
        });
        const raw = await response.text();
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
        const metaErr = (parsed?.error ?? null) as {
          message?: string;
          code?: number;
          error_subcode?: number;
          fbtrace_id?: string;
          type?: string;
        } | null;

        return json(200, {
          ok: response.ok,
          helper: "sendWhatsAppTextMessage-equivalent",
          graph_endpoint: graphEndpoint,
          http_status: response.status,
          message_id: response.ok
            ? ((parsed?.messages as Array<{ id?: string }> | undefined)?.[0]?.id ?? null)
            : null,
          meta_error_code: metaErr?.code ?? null,
          meta_error_subcode: metaErr?.error_subcode ?? null,
          meta_error_message: metaErr?.message ?? null,
          meta_error_type: metaErr?.type ?? null,
          fbtrace_id: metaErr?.fbtrace_id ?? null,
          access_token_sha256_prefix: tokenFingerprint,
          phone_number_id: creds.phoneNumberId,
          waba_id: Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID")?.trim() ?? null,
        });
      }
      if (
        ops?.action === "process_text" &&
        typeof ops.wa_id === "string" &&
        typeof ops.text === "string"
      ) {
        if (!supabaseUrlEarly || !serviceKeyEarly) {
          return json(503, { error: "db_unconfigured" });
        }
        const client = createClient(supabaseUrlEarly, serviceKeyEarly);
        const metaMessageId =
          typeof ops.meta_message_id === "string" && ops.meta_message_id
            ? ops.meta_message_id
            : `ops-${crypto.randomUUID()}`;
        const message = {
          metaMessageId,
          waId: ops.wa_id,
          phoneNumberId: Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")?.trim() ?? null,
          displayName: null,
          messageType: "text",
          textBody: ops.text,
          interactiveId: null,
          timestamp: String(Math.floor(Date.now() / 1000)),
          valueBlock: { ops: true, text: ops.text },
        };
        const { error } = await client.from("whatsapp_inbound_messages").insert({
          meta_message_id: message.metaMessageId,
          wa_id: message.waId,
          message_type: message.messageType,
          inbound_text: message.textBody,
          phone_number_id: message.phoneNumberId,
          raw_payload: message.valueBlock,
        });
        if (error && error.code !== "23505") {
          return json(500, { error: error.message });
        }
        const action = await processWhatsAppInboundMessage(client, message);
        await markInboundProcessed(client, message.metaMessageId, action);
        return json(200, {
          ok: true,
          meta_message_id: metaMessageId,
          workflow_action: action,
          menu_sent: !String(action).includes("fail"),
        });
      }
    } catch (opsErr) {
      console.error("[whatsapp-webhook] ops path failed", String(opsErr));
      return json(500, { error: "ops_failed" });
    }
  }

  const appSecret = Deno.env.get("WHATSAPP_APP_SECRET")?.trim() ?? "";
  if (!appSecret) {
    console.error("[whatsapp-webhook] WHATSAPP_APP_SECRET missing");
    return json(503, { error: "signature_unconfigured" });
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
      // Never silently ACK-and-drop customer messages. A mis-set WABA id would
      // otherwise return 200 and Meta would stop retrying — permanent silence.
      console.error("[whatsapp-webhook] waba_id mismatch — processing inbound anyway", {
        configured_suffix: businessAccountId.slice(-6),
        entry_ids: entries.map((e) => String(e.id ?? "").slice(-6)),
        message_count: parsed.messages.length,
      });
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

  const acceptedMessages: WhatsAppInboundMessage[] = [];

  for (const message of parsed.messages) {
    const { error } = await client.from("whatsapp_inbound_messages").insert({
      meta_message_id: message.metaMessageId,
      wa_id: message.waId,
      message_type: message.messageType,
      inbound_text: message.textBody,
      phone_number_id: message.phoneNumberId,
      raw_payload: message.valueBlock,
    });
    if (error) {
      if (error.code === "23505") {
        // Duplicate Meta delivery of the same meta_message_id — skip.
        console.info("[whatsapp-webhook] duplicate meta_message_id skipped", {
          meta_message_id_prefix: message.metaMessageId.slice(0, 24),
        });
        continue;
      }
      console.error("[whatsapp-webhook] dedupe insert failed", error.message);
      return json(500, { error: "dedupe_failed" });
    }
    acceptedMessages.push(message);
  }

  if (acceptedMessages.length > 0) {
    // Await workflow so post-expiry Hi cannot vanish if waitUntil is dropped.
    // Keep waitUntil as a safety net for platforms that suspend after response.
    const work = processAcceptedMessages(client, acceptedMessages);
    scheduleBackground(work);
    await work;
  }

  return json(200, { ok: true, accepted: acceptedMessages.length });
});
