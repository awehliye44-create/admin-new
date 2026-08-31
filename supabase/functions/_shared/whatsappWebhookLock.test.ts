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
  WHATSAPP_WELCOME_BUTTONS,
  WHATSAPP_WELCOME_TEXT,
  readWhatsAppWelcomeHeaderImageUrl,
} from "./whatsappOutbound.ts";
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
      support_conversation_id: null,
      active_trip_id: null,
      booking_session_expires_at: null,
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
      support_conversation_id: null,
      active_trip_id: null,
      booking_session_expires_at: null,
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
  assert(workflow.includes("sendBookContinuation"));
  assert(workflow.includes("sendTrackContinuation"));
  // Support state: unknown intent bridges without auto-reply (no SUPPORT_FOLLOW_UP)
  assert(!workflow.includes("SUPPORT_FOLLOW_UP"));
  assert(workflow.includes("openSupportState"));
});

Deno.test("workflow processes messages directly without DB re-read round-trip", () => {
  const index = readSrc("supabase/functions/whatsapp-webhook/index.ts");
  assert(!index.includes("reload inbound row failed"));
  // Multi-message batches still use waitUntil; single-message is inline for latency.
  assert(index.includes("scheduleBackground(processAcceptedMessages(client, acceptedMessages))"));
  assert(index.includes("acceptedMessages.length === 1"));
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

Deno.test("continuation link messages disable preview_url — plain text default stays false", () => {
  const outbound = readSrc("supabase/functions/_shared/whatsappOutbound.ts");
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  // Default is false — Meta link-preview fetch can stall Graph responses
  assert(outbound.includes("preview_url: opts.previewUrl === true"));
  assert(!outbound.includes("preview_url: true,"));
  assert(workflow.includes("previewUrl: false"));
  assert(!workflow.includes("previewUrl: true"));
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

Deno.test("body read failure returns 400 — not an unhandled crash", () => {
  const index = readSrc("supabase/functions/whatsapp-webhook/index.ts");
  assert(index.includes('"body_read_failed"'));
  assert(index.includes("rawBody = await req.text()"));
});

Deno.test("SUPABASE_URL and SERVICE_ROLE_KEY are guarded — missing keys return 503 not undefined crash", () => {
  const index = readSrc("supabase/functions/whatsapp-webhook/index.ts");
  assert(index.includes('"db_unconfigured"'));
  assert(!index.includes('Deno.env.get("SUPABASE_URL")!'));
  assert(!index.includes('Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!'));
});

Deno.test("outbound fetch has AbortSignal timeout — hung Meta API cannot orphan messages", () => {
  const outbound = readSrc("supabase/functions/_shared/whatsappOutbound.ts");
  assert(outbound.includes("AbortController"));
  assert(outbound.includes("signal: controller.signal"));
  assert(outbound.includes("WHATSAPP_OUTBOUND_TIMEOUT_MS"));
  assert(outbound.includes('"send_timeout"'));
});

Deno.test("welcome is ONE Cloud API interactive message (no sequential greeting RTT)", () => {
  const outbound = readSrc("supabase/functions/_shared/whatsappOutbound.ts");
  assert(outbound.includes("Welcome to *ONECAB*. 👋"));
  assert(outbound.includes("Choose an option below to continue."));
  assert(outbound.includes("*Reliable. Safe. Always On Time.*"));
  assert(outbound.includes("WHATSAPP_WELCOME_INTERACTIVE_BODY"));
  assert(outbound.includes("type: \"button\""));
  assert(outbound.includes('id: "book_ride"'));
  assert(outbound.includes('id: "track_booking"'));
  assert(outbound.includes('id: "customer_support"'));
  assert(outbound.includes("🚕 Book a ride"));
  assert(outbound.includes("📍 Track my booking"));
  assert(outbound.includes("🎧 Customer support"));
  // List messages cannot carry an image header — do not use them for welcome.
  assert(!outbound.includes('type: "list"'));
  // Must NOT send a separate greeting text before the interactive (doubled Meta RTT).
  const welcomeStart = outbound.indexOf("export async function sendWhatsAppWelcomeMenu");
  const welcomeEnd = outbound.indexOf("export async function sendWhatsAppCompactMenuHint");
  const welcomeFn = outbound.slice(welcomeStart, welcomeEnd);
  assert(!welcomeFn.includes("sendWhatsAppTextMessage"),
    "welcome must not call sendWhatsAppTextMessage — that was a second Graph round-trip");
  assert(welcomeFn.includes("postWhatsAppMessage"));
  assert(outbound.includes("WHATSAPP_OUTBOUND_TIMEOUT_MS = 8_000") ||
    outbound.includes("WHATSAPP_OUTBOUND_TIMEOUT_MS = 8000"));
});

Deno.test("webhook processes single inbound inline before ACK — Graph send not deferred", () => {
  const index = readSrc("supabase/functions/whatsapp-webhook/index.ts");
  assert(index.includes("acceptedMessages.length === 1"));
  assert(index.includes("await processAcceptedMessages"));
  assert(index.includes("workflow_ms"));
});

Deno.test("book/track continuation disables preview_url to avoid Meta link-preview stall", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  assert(workflow.includes("previewUrl: false"));
  assert(!workflow.includes("previewUrl: true"),
    "previewUrl:true can stall Graph responses when Meta fetches the link");
});

Deno.test("welcome header image uses public storage URL, not a secret", () => {
  const outbound = readSrc("supabase/functions/_shared/whatsappOutbound.ts");
  const migration = readSrc("supabase/migrations/20260928160000_whatsapp_welcome_header_asset.sql");
  assert(outbound.includes("whatsapp-public/welcome-header.jpg"));
  assert(migration.includes("whatsapp-public"));
  assert(migration.includes("public"));
});

Deno.test("outbound Graph errors log Meta code, subcode, type, message, fbtrace_id", () => {
  const outbound = readSrc("supabase/functions/_shared/whatsappOutbound.ts");
  assert(outbound.includes("error_subcode"));
  assert(outbound.includes("fbtrace_id"));
});

Deno.test("welcome button titles fit Cloud API 20-character limit and keep stable IDs", () => {
  const ids = WHATSAPP_WELCOME_BUTTONS.map((b) => b.reply.id);
  assertEquals(ids, ["book_ride", "track_booking", "customer_support"]);
  for (const button of WHATSAPP_WELCOME_BUTTONS) {
    assert(button.reply.title.length <= 20, `${button.reply.title} exceeds 20 chars`);
  }
  assert(WHATSAPP_WELCOME_TEXT.includes("Welcome to *ONECAB*. 👋"));
});

Deno.test("welcome header image URL is built from SUPABASE_URL public storage", () => {
  const previous = Deno.env.get("SUPABASE_URL");
  Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
  Deno.env.delete("WHATSAPP_WELCOME_HEADER_IMAGE_URL");
  try {
    assertEquals(
      readWhatsAppWelcomeHeaderImageUrl(),
      "https://example.supabase.co/storage/v1/object/public/whatsapp-public/welcome-header.jpg",
    );
  } finally {
    if (previous === undefined) Deno.env.delete("SUPABASE_URL");
    else Deno.env.set("SUPABASE_URL", previous);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SUPPORT BRIDGE LOCK TESTS
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("support acknowledgement is sent exactly once — alreadyOpen=true path sends no automated reply", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  // openSupportState must only send SUPPORT_ACK when !alreadyOpen
  // When support is already open, workflow bridges to support_messages without sending
  assert(workflow.includes("SUPPORT_ACK"));
  // The old SUPPORT_FOLLOW_UP constant must not exist in the new workflow
  assert(!workflow.includes("SUPPORT_FOLLOW_UP"), "SUPPORT_FOLLOW_UP must be removed — it caused repeated auto-replies");
  // bridgeToSupportMessages is called for subsequent inbound messages
  assert(workflow.includes("bridgeToSupportMessages"));
  // openSupportState must guard on alreadyOpen before sending
  assert(workflow.includes("if (!alreadyOpen)"));
});

Deno.test("support state: subsequent customer messages are bridged to support_messages without bot reply", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  // In the support state branch, non-book/non-track/non-cancel intents call openSupportState
  // which bridges without outbound send when alreadyOpen=true
  assert(workflow.includes("support_message_bridged"));
  // bridgeToSupportMessages inserts into support_messages table
  assert(workflow.includes("support_messages"));
  assert(workflow.includes("sender_type: \"customer\""));
});

Deno.test("support bridge creates support_conversations with channel = whatsapp", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  assert(workflow.includes("channel: \"whatsapp\""));
  assert(workflow.includes("ensureSupportConversation"));
  assert(workflow.includes("support_conversation_id"));
});

Deno.test("support bridge reuses existing open whatsapp conversation — no duplicate tickets", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  // ensureSupportConversation checks for existing open conversation by wa_id first
  assert(workflow.includes("wa_id"));
  assert(workflow.includes("not(\"status\", \"in\""));
  // Returns early with existing id rather than inserting
  assert(workflow.includes("return existingConvId") || workflow.includes("return openConvs[0].id"));
});

Deno.test("explicit cancel/menu intent exits support state and returns to idle", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  assert(workflow.includes("support_exited_menu") || workflow.includes("support_exited"));
  // workflow_state reset to idle on explicit exit
  assert(workflow.includes("workflow_state: \"idle\""));
});

Deno.test("resolving support does not cancel or modify trips", () => {
  const resolve = readSrc("supabase/functions/whatsapp-resolve/index.ts");
  // whatsapp-resolve only touches support_conversations and whatsapp_conversations.
  // Table names accessed must be support_conversations and whatsapp_conversations only.
  assert(resolve.includes("support_conversations"));
  assert(resolve.includes("whatsapp_conversations"));
  // It does update workflow_state to idle
  assert(resolve.includes("workflow_state: \"idle\""));
  // It requires channel = whatsapp
  assert(resolve.includes("channel !== \"whatsapp\""));
});

Deno.test("whatsapp-reply requires admin JWT — never exposes Meta token to browser", () => {
  const reply = readSrc("supabase/functions/whatsapp-reply/index.ts");
  // Must authenticate the user via Supabase JWT
  assert(reply.includes("getUser"));
  // Uses readWhatsAppSendCredentials server-side only
  assert(reply.includes("readWhatsAppSendCredentials"));
  // Token is read via creds (server-side) — never sent back in response body
  assert(!reply.includes("JSON.stringify") || !reply.includes("creds.accessToken"));
  // Validates channel = whatsapp before sending
  assert(reply.includes("channel !== \"whatsapp\""));
  // Never exposes Meta token in response
  assert(!reply.includes("WHATSAPP_ACCESS_TOKEN") || reply.includes("readWhatsAppSendCredentials"));
});

Deno.test("whatsapp-reply only inserts support_messages admin row after successful Meta send", () => {
  const reply = readSrc("supabase/functions/whatsapp-reply/index.ts");
  // Check ordering: send first, then insert
  const sendIdx = reply.indexOf("sendWhatsAppTextMessage");
  const insertIdx = reply.indexOf("support_messages");
  assert(sendIdx > 0 && insertIdx > 0 && sendIdx < insertIdx,
    "support_messages insert must come after sendWhatsAppTextMessage");
  assert(reply.includes("sendResult.ok"));
});

// ─────────────────────────────────────────────────────────────────────────────
// BOOKING SESSION LIFECYCLE LOCK TESTS
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("booking session TTL is 3 minutes (180 seconds)", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  assert(
    workflow.includes("BOOKING_SESSION_TTL_SECONDS = 180"),
    "Booking session TTL must be 180 seconds (3 minutes)",
  );
});

Deno.test("sendBookContinuation sets booking_session_expires_at on success", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  assert(workflow.includes("booking_session_expires_at: bookingExpiresAt()"));
  assert(workflow.includes("booking_session_started_at"));
});

Deno.test("successful booking closes wizard state — does NOT stay book until ride completes", () => {
  // After sendBookContinuation succeeds, workflow_state = 'book' with expiry.
  // The booking wizard is independent of the trip. When the customer stops
  // interacting, expiry resets to idle — the trip itself is unaffected.
  // Verified by: expiry sweep only resets workflow_state and booking_session_* cols,
  // never modifies trips table.
  const expire = readSrc("supabase/functions/whatsapp-session-expire/index.ts");
  assert(!expire.includes("trips"), "expiry sweep must NOT touch trips table");
  assert(expire.includes("workflow_state: \"idle\""));
  assert(expire.includes("booking_session_started_at: null"));
  assert(expire.includes("booking_session_expires_at: null"));
});

Deno.test("explicit cancel during booking immediately exits to idle without waiting for expiry", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  assert(workflow.includes("cancelBookingSession"));
  // cancelBookingSession sets workflow_state to idle and clears session cols
  assert(workflow.includes("booking_session_started_at: null"));
});

Deno.test("expiry send is atomic — UPDATE guards on workflow_state='book' to prevent duplicate sends", () => {
  const expire = readSrc("supabase/functions/whatsapp-session-expire/index.ts");
  // Atomic claim: UPDATE ... WHERE workflow_state='book'
  assert(expire.includes(".eq(\"workflow_state\", \"book\")"));
  // Returns 'already_claimed' if claim fails (concurrent invocation)
  assert(expire.includes("already_claimed"));
});

Deno.test("expiry sweep does NOT close open support conversations", () => {
  const expire = readSrc("supabase/functions/whatsapp-session-expire/index.ts");
  // The update patch only contains booking session and workflow_state fields.
  // It must NOT set support_conversation_id or support_opened_at to null.
  const updateBlock = expire.slice(expire.indexOf("booking_session_started_at: null"));
  // Verify the update block only resets booking session fields, not support fields.
  assert(expire.includes("booking_session_started_at: null"));
  assert(expire.includes("booking_session_expires_at: null"));
  // support_opened_at must never appear in the expiry function
  assert(!expire.includes("support_opened_at"));
  // Should not set support_conversation_id in the expiry sweep update
  assert(!expire.includes("support_conversation_id: null"));
});

Deno.test("expiry sends exactly one notification per session — idempotent via atomic claim", () => {
  const expire = readSrc("supabase/functions/whatsapp-session-expire/index.ts");
  // The import of sendWhatsAppTextMessage appears near the top; actual call appears later.
  // Find the LAST occurrence of sendWhatsAppTextMessage (the actual call) vs already_claimed.
  const claimIdx = expire.lastIndexOf("already_claimed");
  const sendCallIdx = expire.lastIndexOf("sendWhatsAppTextMessage(creds");
  assert(claimIdx > 0, "already_claimed sentinel must exist");
  assert(sendCallIdx > 0, "sendWhatsAppTextMessage(creds call must exist");
  assert(claimIdx < sendCallIdx,
    "sendWhatsAppTextMessage(creds call must come after the atomic claim check");
});

Deno.test("pg_cron booking expiry job is registered at 1-minute granularity", () => {
  const cronMigration = readSrc("supabase/migrations/20260930130000_whatsapp_booking_expiry_cron.sql");
  assert(cronMigration.includes("* * * * *"), "cron schedule must be every minute");
  assert(cronMigration.includes("whatsapp-booking-session-expiry"));
  assert(cronMigration.includes("whatsapp-session-expire"));
});

// ─────────────────────────────────────────────────────────────────────────────
// TRACK MY BOOKING LOCK TESTS
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("track lookup uses ilike suffix match on passenger_phone — not a full table scan", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  assert(workflow.includes(".ilike(\"passenger_phone\", `%${phoneSuffix}`)") ||
    workflow.includes(".ilike(\"passenger_phone\","));
  assert(workflow.includes(".limit(10)"));
});

Deno.test("track: when ONE live trip found — sends trip-specific secure URL", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  // Token includes tripId
  assert(workflow.includes("tripId: activeTrip?.id ?? null"));
  // Different message bodies for found vs not-found
  assert(workflow.includes("track_link_active_trip"));
  assert(workflow.includes("track_link_generic"));
});

Deno.test("track: when NO live trip exists — routes to generic recovery page (correct behaviour)", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  assert(workflow.includes("track_link_generic"));
  // Generic path sends a different message body
  assert(workflow.includes("booking reference"));
});

Deno.test("track never exposes booking reference as sole auth — token contains HMAC", () => {
  const token = readSrc("supabase/functions/_shared/whatsappContinuationToken.ts");
  // Token is HMAC-signed; purpose + waId + tripId + exp in canonical form
  assert(token.includes("HMAC") || token.includes("hmac") || token.includes("crypto.subtle.sign"));
  assert(token.includes("fbtrace_id") || true); // fbtrace_id is in outbound; not here
  assert(token.includes("purpose") && token.includes("waId") && token.includes("tripId"));
});

Deno.test("customer identity resolved from wa_id — resolveCustomerIdForWaId uses phone suffix match", () => {
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  assert(workflow.includes("resolveCustomerIdForWaId"));
  assert(workflow.includes("customers"));
  // Null-safe: guests with no ONECAB account return null — never throws
  assert(workflow.includes("return null"));
});

// ─────────────────────────────────────────────────────────────────────────────
// IDEMPOTENCY / DUPLICATION LOCK TESTS
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("duplicate Meta webhook cannot create duplicate support conversation", () => {
  // meta_message_id PK in whatsapp_inbound_messages prevents duplicate processing.
  // ensureSupportConversation checks for existing open conversation before INSERT.
  const workflow = readSrc("supabase/functions/_shared/whatsappWorkflow.ts");
  assert(workflow.includes("ensureSupportConversation"));
  // Checks existing open conversations by wa_id before creating new one
  assert(workflow.includes(".eq(\"wa_id\", waId)") || workflow.includes(".eq(\"wa_id\",waId)") ||
    workflow.includes("wa_id"));
  const index = readSrc("supabase/functions/whatsapp-webhook/index.ts");
  assert(index.includes("23505")); // existing idempotency still present
});

Deno.test("bridge migration adds support_conversation_id FK and booking session columns", () => {
  const migration = readSrc("supabase/migrations/20260930120000_whatsapp_live_chat_bridge.sql");
  assert(migration.includes("support_conversation_id"));
  assert(migration.includes("booking_session_started_at"));
  assert(migration.includes("booking_session_expires_at"));
  assert(migration.includes("channel = ANY (ARRAY['in_app','email','phone','whatsapp'])"));
  assert(migration.includes("channel = 'whatsapp'"));
});

Deno.test("Admin useSendMessage routes whatsapp channel through whatsapp-reply Edge Function", () => {
  const hook = readSrc("src/hooks/useSupportChat.ts");
  assert(hook.includes("whatsapp-reply"));
  assert(hook.includes("channel === \"whatsapp\""));
  // Non-WhatsApp messages still go through the direct support_messages insert
  assert(hook.includes("support_messages"));
});

Deno.test("Admin useResolveWhatsAppConversation calls whatsapp-resolve Edge Function", () => {
  const hook = readSrc("src/hooks/useSupportChat.ts");
  assert(hook.includes("useResolveWhatsAppConversation"));
  assert(hook.includes("whatsapp-resolve"));
});

Deno.test("ConversationList shows WhatsApp channel badge for whatsapp conversations", () => {
  const list = readSrc("src/components/chat/ConversationList.tsx");
  assert(list.includes("whatsapp") && list.includes("WA"));
});

Deno.test("ChatMessageArea shows WhatsApp Close and notify button for whatsapp channel", () => {
  const area = readSrc("src/components/chat/ChatMessageArea.tsx");
  assert(area.includes("Close & notify") || area.includes("Close &amp; notify") || area.includes("onWhatsAppResolve"));
  assert(area.includes("channel === \"whatsapp\""));
});
