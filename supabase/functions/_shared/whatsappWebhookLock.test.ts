/**
 * WhatsApp webhook lock tests.
 * Run: deno test supabase/functions/_shared/whatsappWebhookLock.test.ts
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildWhatsAppContinuationSigningMaterial,
  createWhatsAppContinuationToken,
  verifyWhatsAppContinuationToken,
} from "./whatsappContinuationToken.ts";
import { parseWhatsAppWebhookPayload } from "./whatsappInboundParse.ts";
import {
  readWhatsAppHubVerifyQuery,
  verifyWhatsAppHubChallenge,
  verifyWhatsAppWebhookSignature,
} from "./whatsappWebhookVerify.ts";
import {
  resolveWhatsAppWorkflowIntent,
  shouldSendWhatsAppWelcome,
} from "./whatsappWorkflow.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

Deno.test("GET verify returns hub.challenge when token matches", () => {
  const query = readWhatsAppHubVerifyQuery(
    new URL("https://example.com/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=abc&hub.challenge=12345"),
  );
  const result = verifyWhatsAppHubChallenge(query, "abc");
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.challenge, "12345");
});

Deno.test("GET verify rejects invalid token with forbidden semantics", () => {
  const query = readWhatsAppHubVerifyQuery(
    new URL("https://example.com/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345"),
  );
  assertEquals(verifyWhatsAppHubChallenge(query, "abc").ok, false);
});

Deno.test("POST signature uses Meta X-Hub-Signature-256 sha256 HMAC", async () => {
  const secret = "test-app-secret";
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  assertEquals(
    await verifyWhatsAppWebhookSignature(body, `sha256=${hex}`, secret),
    true,
  );
  assertEquals(await verifyWhatsAppWebhookSignature(body, "sha256=deadbeef", secret), false);
});

Deno.test("parseWhatsAppWebhookPayload extracts inbound text and interactive ids", () => {
  const parsed = parseWhatsAppWebhookPayload({
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: "123" },
          contacts: [{ wa_id: "447700900000", profile: { name: "Alex" } }],
          messages: [{
            from: "447700900000",
            id: "wamid.TEST123",
            timestamp: "1700000000",
            type: "interactive",
            interactive: {
              type: "button_reply",
              button_reply: { id: "book_ride", title: "Book a ride" },
            },
          }],
        },
      }],
    }],
  });
  assertEquals(parsed.messages.length, 1);
  assertEquals(parsed.messages[0]?.metaMessageId, "wamid.TEST123");
  assertEquals(parsed.messages[0]?.interactiveId, "book_ride");
  assertEquals(parsed.messages[0]?.displayName, "Alex");
});

Deno.test("workflow intent maps menu choices for book, track and support", () => {
  assertEquals(
    resolveWhatsAppWorkflowIntent({ textBody: null, interactiveId: "track_booking" }),
    "track",
  );
  assertEquals(resolveWhatsAppWorkflowIntent({ textBody: "Book a ride", interactiveId: null }), "book");
  assertEquals(resolveWhatsAppWorkflowIntent({ textBody: "2", interactiveId: null }), "track");
  assertEquals(resolveWhatsAppWorkflowIntent({ textBody: "help me", interactiveId: null }), "support");
});

Deno.test("welcome menu is sent only once per conversation", () => {
  assertEquals(
    shouldSendWhatsAppWelcome({
      wa_id: "1",
      display_name: null,
      workflow_state: "new",
      welcome_sent_at: null,
      support_opened_at: null,
      active_trip_id: null,
    }),
    true,
  );
  assertEquals(
    shouldSendWhatsAppWelcome({
      wa_id: "1",
      display_name: null,
      workflow_state: "idle",
      welcome_sent_at: "2026-01-01T00:00:00.000Z",
      support_opened_at: null,
      active_trip_id: null,
    }),
    false,
  );
});

Deno.test("continuation tokens are signed and expire deterministically", async () => {
  const material = buildWhatsAppContinuationSigningMaterial({
    verifyToken: "verify",
    phoneNumberId: "phone-id",
  });
  const token = await createWhatsAppContinuationToken(
    { purpose: "book", waId: "447700900000", tripId: null, ttlSeconds: 120 },
    material,
    1_700_000_000,
  );
  const claims = await verifyWhatsAppContinuationToken(token, material, 1_700_000_000);
  assert(claims);
  assertEquals(claims?.purpose, "book");
  assertEquals(claims?.waId, "447700900000");
  assertEquals(
    await verifyWhatsAppContinuationToken(token, material, 1_700_000_300),
    null,
  );
});

Deno.test("edge function keeps secrets server-side and disables Supabase JWT", () => {
  const index = readSrc("supabase/functions/whatsapp-webhook/index.ts");
  const config = readSrc("supabase/config.toml");
  assert(index.includes("WHATSAPP_WEBHOOK_VERIFY_TOKEN"));
  assert(index.includes("WHATSAPP_APP_SECRET"));
  assert(index.includes("WHATSAPP_ACCESS_TOKEN"));
  assert(index.includes("WHATSAPP_PHONE_NUMBER_ID"));
  assert(index.includes("WHATSAPP_BUSINESS_ACCOUNT_ID"));
  assert(!index.includes("return json(200, { verify_token"));
  assert(index.includes("verifyWhatsAppWebhookSignature"));
  assert(index.includes("EdgeRuntime.waitUntil"));
  assert(config.includes("[functions.whatsapp-webhook]"));
  assert(config.includes("verify_jwt = false"));
});

Deno.test("migration defines inbound dedupe and conversation workflow tables", () => {
  const sql = readSrc("supabase/migrations/20260928130000_whatsapp_webhook_ssot.sql");
  assert(sql.includes("whatsapp_inbound_messages"));
  assert(sql.includes("meta_message_id text primary key"));
  assert(sql.includes("whatsapp_conversations"));
  assert(sql.includes("welcome_sent_at"));
  assert(sql.includes("workflow_state"));
});
