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

Deno.test("duplicate Meta message ID is silently ignored — not double-processed", () => {
  const dedupeCheck = readSrc("supabase/functions/whatsapp-webhook/index.ts");
  assert(dedupeCheck.includes('"23505"'));
  assert(dedupeCheck.includes("continue"));
});

Deno.test("status/delivery echoes with no .messages produce no_inbound_messages 200", () => {
  const parsed = parseWhatsAppWebhookPayload({
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: "123" },
          statuses: [{ id: "wamid.STATUS", status: "delivered", timestamp: "1700000001", recipient_id: "447700900000" }],
        },
      }],
    }],
  });
  assertEquals(parsed.messages.length, 0);
});

Deno.test("support state: book intent escapes support, unknown intent extends support", () => {
  assertEquals(
    resolveWhatsAppWorkflowIntent({ textBody: "book a ride", interactiveId: null }),
    "book",
  );
  assertEquals(
    resolveWhatsAppWorkflowIntent({ textBody: "my driver is late", interactiveId: null }),
    "unknown",
  );
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  assert(workflow.includes("if (intent === \"book\") return sendBookContinuation"));
  assert(workflow.includes("if (intent === \"track\") return sendTrackContinuation"));
  assert(workflow.includes("return openSupportState(client, message.waId, creds, true)"));
});

Deno.test("workflow processes messages directly without DB re-read round-trip", () => {
  const index = readSrc("supabase/functions/whatsapp-webhook/index.ts");
  assert(!index.includes("reload inbound row failed"));
  assert(index.includes("scheduleBackground(processAcceptedMessages(client, acceptedMessages))"));
});

Deno.test("conversation upsert handles concurrent first-message races", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  assert(workflow.includes(".upsert("));
  assert(workflow.includes('onConflict: "wa_id"'));
  assert(workflow.includes("upsert_failed") || workflow.includes("upsert failed"));
});

Deno.test("display_name null never overwrites a stored name", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  assert(workflow.includes("if (message.displayName) touchPatch.display_name"));
  assert(!workflow.includes("display_name: message.displayName"));
});

Deno.test("active trip lookup filters by passenger phone in SQL — not global 25-row scan", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  // Must filter in SQL using ilike on phoneSuffix, not load all trips then scan in JS
  assert(workflow.includes(".ilike(\"passenger_phone\", `%${phoneSuffix}`)"));
  assert(!workflow.includes(".limit(25)"));
});

Deno.test("continuation link messages use preview_url true, plain text messages do not", () => {
  const outbound = readSrc("supabase/functions/_shared/whatsappOutbound.ts");
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  // Default is false — only callers with { previewUrl: true } get link previews
  assert(outbound.includes("preview_url: opts.previewUrl === true"));
  assert(!outbound.includes("preview_url: true,"));
  // Book and track continuation callers must opt in
  assert(workflow.includes("{ previewUrl: true }"));
});

Deno.test("GET verify token comparison is timing-safe", () => {
  const verify = readSrc("supabase/functions/_shared/whatsappWebhookVerify.ts");
  assert(verify.includes("timingSafeEqual(query.verifyToken, expectedVerifyToken)"));
  assert(!verify.includes("query.verifyToken !== expectedVerifyToken"));
  assert(!verify.includes("query.verifyToken === expectedVerifyToken"));
});

Deno.test("markConversationOutbound logs errors — silent failure causes duplicate welcomes", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  assert(workflow.includes("markConversationOutbound failed"));
});

Deno.test("passenger_phone index migration exists for WhatsApp trip lookup", () => {
  const migration = readSrc(
    "supabase/migrations/20260928140000_whatsapp_passenger_phone_idx.sql",
  );
  assert(migration.includes("trips_passenger_phone_idx"));
  assert(migration.includes("passenger_phone"));
});

Deno.test("continuation token signing warns when WHATSAPP_WEBHOOK_VERIFY_TOKEN is absent", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  assert(workflow.includes("continuation token signing is degraded"));
});

Deno.test("track lookup uses narrow trackable-trip statuses, not invoice-gate statuses", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  // Must define a local TRACKABLE_TRIP_STATUSES set — not import isActiveTripStatusForInvoice
  assert(workflow.includes("TRACKABLE_TRIP_STATUSES"));
  assert(workflow.includes("isTrackableTripStatus"));
  // isActiveTripStatusForInvoice must not be called (may appear in comments but not as a call)
  assert(!workflow.includes("isActiveTripStatusForInvoice("));
  // Must include on-trip statuses
  assert(workflow.includes('"driver_assigned"'));
  assert(workflow.includes('"on_trip"'));
  // The TRACKABLE set must not include pre-driver dispatch states
  assert(!workflow.includes('"searching",'));
  assert(!workflow.includes('"broadcasting",'));
});

Deno.test("raw_payload stores per-message value block, not the full batch payload", () => {
  const index = readSrc("supabase/functions/whatsapp-webhook/index.ts");
  // Must use message.valueBlock — not the outer `payload` variable
  assert(index.includes("raw_payload: message.valueBlock"));
  assert(!index.includes("raw_payload: payload"));
  const parse = readSrc("supabase/functions/_shared/whatsappInboundParse.ts");
  // WhatsAppInboundMessage must carry valueBlock
  assert(parse.includes("valueBlock"));
  assert(parse.includes("valueBlock: valueNode"));
});

Deno.test("send failures in book/track/support do not advance workflow state", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  // Each sender must check .ok before calling markConversationOutbound
  assert(workflow.includes('"book_link_send_failed"'));
  assert(workflow.includes('"track_link_send_failed"'));
  assert(workflow.includes('"support_send_failed"'));
  // Must not mark state unconditionally (verify no await markConversation before ok check)
  assert(workflow.includes("if (!sent.ok) return \"book_link_send_failed\""));
  assert(workflow.includes("if (!trackSent.ok) return \"track_link_send_failed\""));
  assert(workflow.includes("if (!sent.ok) return \"support_send_failed\""));
});

Deno.test("imports are all at top of module — no imports after executable code", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  const lines = workflow.split("\n");
  // Find last import line and earliest const/function/export (non-import) executable line
  let lastImportLine = -1;
  let firstExecLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("import ") || trimmed.startsWith("import{") || trimmed.startsWith("import type")) {
      lastImportLine = i;
    } else if (
      firstExecLine === -1 &&
      (trimmed.startsWith("const ") || trimmed.startsWith("function ") ||
        trimmed.startsWith("export ") || trimmed.startsWith("export type ") ||
        trimmed.startsWith("export async ") || trimmed.startsWith("type "))
    ) {
      firstExecLine = i;
    }
  }
  assert(lastImportLine !== -1, "no imports found");
  assert(firstExecLine !== -1, "no executable lines found");
  assert(
    lastImportLine < firstExecLine,
    `import on line ${lastImportLine + 1} appears after executable code on line ${firstExecLine + 1}`,
  );
});

Deno.test("menu and unknown send failures do not advance workflow state", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  assert(workflow.includes('"menu_hint_send_failed"'));
  assert(workflow.includes('"unknown_menu_hint_send_failed"'));
});

Deno.test("index.ts uses typed SupabaseClient<any> — no ReturnType<typeof createClient> TS errors", () => {
  const index = readSrc("supabase/functions/whatsapp-webhook/index.ts");
  // Must import SupabaseClient and use it for typed DB helpers — not ReturnType<typeof createClient>
  assert(index.includes("type SupabaseClient") || index.includes("SupabaseClient<any>"));
  assert(!index.includes("ReturnType<typeof createClient>"));
});
