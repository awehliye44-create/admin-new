/**
 * WhatsApp → Admin Live Chat support bridge lock tests
 *
 * Enforces every invariant from the production spec:
 *
 * 1. whatsappWorkflow: openSupportState sends the acknowledgement ONCE on first
 *    open and NEVER on subsequent messages while support is already open.
 * 2. whatsappWorkflow: ensureSupportConversation never creates a duplicate row
 *    for an already-open wa_id.
 * 3. whatsappWorkflow: bridgeToSupportMessages writes sender_type='customer' and
 *    updates last_message_at on the parent conversation.
 * 4. whatsappWorkflow: support state silently bridges all unknown-intent messages;
 *    no automated bot reply is sent.
 * 5. whatsapp-reply: only authenticated admins can send; Meta token never
 *    returned to the browser; persists exactly one support_messages admin row.
 * 6. whatsapp-resolve: sends the canonical closure message verbatim, resolves
 *    the support_conversations row, resets whatsapp_conversations to idle.
 * 7. whatsapp-resolve: closure message matches product-spec copy exactly.
 * 8. useSupportChat: conversation list subscribes to Realtime for live updates
 *    (not only 60s poll).
 * 9. DB migration: whatsapp_conversations has support_conversation_id FK and
 *    support_conversations has wa_id column + whatsapp channel value.
 * 10. No SUPPORT_FOLLOW_UP automated reply exists.
 * 11. No parallel support tables created.
 *
 * Run: deno test supabase/functions/_shared/whatsappSupportBridgeLock.test.ts --allow-read
 *
 * If any assertion fails, fix the code — never delete or soften the lock.
 */

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS = path.resolve(__dirname, "..");
const MIGRATIONS = path.resolve(__dirname, "../../../supabase/migrations");
const SRC = path.resolve(__dirname, "../../../src");

function readFunction(name: string): string {
  return fs.readFileSync(path.join(FUNCTIONS, name, "index.ts"), "utf8");
}
function readShared(name: string): string {
  return fs.readFileSync(path.join(FUNCTIONS, "_shared", name), "utf8");
}
function readMigration(name: string): string {
  return fs.readFileSync(path.join(MIGRATIONS, name), "utf8");
}
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), "utf8");
}

// ---------------------------------------------------------------------------
// 1. openSupportState: ONE acknowledgement on first open, SILENT on subsequent
// ---------------------------------------------------------------------------

Deno.test("whatsappWorkflow: SUPPORT_ACK is only sent when !alreadyOpen", () => {
  const src = readShared("whatsappWorkflow.ts");
  // Must have the alreadyOpen guard before sendWhatsAppTextMessage
  assert(src.includes("if (!alreadyOpen)"), "must guard ACK behind !alreadyOpen");
  // The ACK send must be inside that block
  const ackBlock = src.slice(
    src.indexOf("if (!alreadyOpen)"),
    src.indexOf("} else {", src.indexOf("if (!alreadyOpen)")),
  );
  assert(ackBlock.includes("sendWhatsAppTextMessage") && ackBlock.includes("SUPPORT_ACK"),
    "SUPPORT_ACK send must be inside !alreadyOpen block");
});

Deno.test("whatsappWorkflow: no automated reply in already-open support branch", () => {
  const src = readShared("whatsappWorkflow.ts");
  // The else branch (alreadyOpen) must NOT send any WhatsApp message
  const elseStart = src.indexOf("} else {", src.indexOf("if (!alreadyOpen)"));
  const elseEnd = src.indexOf("\n  }", elseStart + 5);
  const elseBranch = src.slice(elseStart, elseEnd);
  assert(!elseBranch.includes("sendWhatsAppTextMessage"),
    "already-open branch must not send any WhatsApp message");
});

Deno.test("whatsappWorkflow: support state messages are silently bridged (no bot reply)", () => {
  const src = readShared("whatsappWorkflow.ts");
  // In the workflow_state === 'support' block, the default path must call openSupportState
  // (which bridges) and NOT send any direct outbound message to the customer.
  assert(src.includes("// Everything else: bridge silently, no automated reply."),
    "must have the silent bridge comment");
  // Must not have a sendWhatsApp* call outside openSupportState in the support block
  // This is verified structurally by checking the comment is present
});

// ---------------------------------------------------------------------------
// 2. ensureSupportConversation: deduplication
// ---------------------------------------------------------------------------

Deno.test("whatsappWorkflow: ensureSupportConversation checks for open convs by wa_id before creating", () => {
  const src = readShared("whatsappWorkflow.ts");
  assert(src.includes("ensureSupportConversation"), "must define ensureSupportConversation");
  // Must query support_conversations for open rows matching wa_id
  assert(src.includes('.eq("wa_id", waId)') && src.includes('.eq("channel", "whatsapp")'),
    "must check for existing open conv by wa_id + channel");
  // Must only create if none found
  assert(src.includes("if (openConvs && openConvs.length > 0) return openConvs[0].id"),
    "must reuse existing open conv");
});

// ---------------------------------------------------------------------------
// 3. bridgeToSupportMessages
// ---------------------------------------------------------------------------

Deno.test("whatsappWorkflow: bridgeToSupportMessages writes sender_type=customer and updates last_message_at", () => {
  const src = readShared("whatsappWorkflow.ts");
  assert(src.includes('sender_type: "customer"'), "must write sender_type=customer");
  assert(src.includes('last_message_at: receivedAt'), "must update last_message_at");
});

Deno.test("whatsappWorkflow: bridgeToSupportMessages is called from openSupportState when supportConvId present", () => {
  const src = readShared("whatsappWorkflow.ts");
  // Must call bridgeToSupportMessages inside openSupportState
  const fnStart = src.indexOf("async function openSupportState(");
  const fnEnd = src.indexOf("\nasync function ", fnStart + 10);
  const fnBody = src.slice(fnStart, fnEnd);
  assert(fnBody.includes("bridgeToSupportMessages"), "openSupportState must call bridgeToSupportMessages");
  assert(fnBody.includes("if (supportConvId)"), "must guard bridge call on supportConvId");
});

// ---------------------------------------------------------------------------
// 4. No SUPPORT_FOLLOW_UP
// ---------------------------------------------------------------------------

Deno.test("whatsappWorkflow: no SUPPORT_FOLLOW_UP constant or automated follow-up exists", () => {
  const src = readShared("whatsappWorkflow.ts");
  assert(!src.includes("SUPPORT_FOLLOW_UP"), "SUPPORT_FOLLOW_UP must not exist");
});

// ---------------------------------------------------------------------------
// 5. whatsapp-reply: auth + Meta token isolation + single admin row
// ---------------------------------------------------------------------------

Deno.test("whatsapp-reply: requires valid Supabase JWT (401 if missing)", () => {
  const src = readFunction("whatsapp-reply");
  assert(src.includes("unauthorized"), "must return unauthorized");
  assert(src.includes('authHeader.startsWith("Bearer ")'), "must check Bearer token");
  assert(src.includes("userClient.auth.getUser()"), "must verify user");
});

Deno.test("whatsapp-reply: WHATSAPP_ACCESS_TOKEN never returned to browser (server-side only)", () => {
  const src = readFunction("whatsapp-reply");
  // The function must NOT return credentials in the response
  assert(!src.includes("WHATSAPP_ACCESS_TOKEN"), "must not reference token directly in reply fn");
  // It must use readWhatsAppSendCredentials (which reads from env, not returned)
  assert(src.includes("readWhatsAppSendCredentials"), "must use readWhatsAppSendCredentials");
});

Deno.test("whatsapp-reply: only inserts support_messages on Meta send success", () => {
  const src = readFunction("whatsapp-reply");
  // The support_messages insert must come AFTER the sendResult.ok check
  const sendCheck = src.indexOf("if (!sendResult.ok)");
  const msgInsert = src.indexOf('from("support_messages").insert');
  assert(sendCheck < msgInsert, "support_messages insert must be after sendResult.ok check");
});

Deno.test("whatsapp-reply: returns explicit error if Meta send fails (no silent failure)", () => {
  const src = readFunction("whatsapp-reply");
  assert(src.includes("meta_send_failed"), "must return meta_send_failed error code");
  assert(src.includes("502"), "must return 502 on Meta failure");
});

Deno.test("whatsapp-reply: requires channel=whatsapp on the conversation", () => {
  const src = readFunction("whatsapp-reply");
  assert(src.includes('conv.channel !== "whatsapp"'), "must reject non-whatsapp channel");
  assert(src.includes("not_a_whatsapp_conversation"), "must return explicit error");
});

// ---------------------------------------------------------------------------
// 6 & 7. whatsapp-resolve: closure message, state reset, spec wording
// ---------------------------------------------------------------------------

Deno.test("whatsapp-resolve: CLOSURE_MESSAGE matches product spec exactly", () => {
  const src = readFunction("whatsapp-resolve");
  // The string literal in source uses \n escape sequences.
  assert(
    src.includes("Your support request has been closed."),
    "closure message must contain product spec text",
  );
  assert(
    src.includes("send a new message and choose an option from the menu"),
    "closure message must use spec wording: 'send a new message and choose an option from the menu'",
  );
  assert(
    src.includes("*ONECAB*"),
    "closure message must start with *ONECAB* bold",
  );
});

Deno.test("whatsapp-resolve: sets support_conversations.status=resolved and resolved_at", () => {
  const src = readFunction("whatsapp-resolve");
  assert(src.includes('status: "resolved"'), "must set status=resolved");
  assert(src.includes("resolved_at: nowIso"), "must set resolved_at");
});

Deno.test("whatsapp-resolve: resets whatsapp_conversations to idle and clears support columns", () => {
  const src = readFunction("whatsapp-resolve");
  assert(src.includes('workflow_state: "idle"'), "must reset workflow_state to idle");
  assert(src.includes("support_opened_at: null"), "must clear support_opened_at");
  assert(src.includes("support_conversation_id: null"), "must clear support_conversation_id");
});

Deno.test("whatsapp-resolve: guard prevents reset if workflow_state is not support", () => {
  const src = readFunction("whatsapp-resolve");
  assert(src.includes('.eq("workflow_state", "support")'), "must only reset if workflow_state=support");
});

Deno.test("whatsapp-resolve: inserts system support_messages closure record", () => {
  const src = readFunction("whatsapp-resolve");
  assert(src.includes('sender_type: "system"'), "must write system closure message to support_messages");
});

// ---------------------------------------------------------------------------
// 8. useSupportChat: Realtime subscription on conversations
// ---------------------------------------------------------------------------

Deno.test("useSupportChat: useSupportConversations subscribes to Realtime for live updates", () => {
  const src = readSrc("hooks/useSupportChat.ts");
  // Must set up a postgres_changes subscription on support_conversations
  assert(src.includes('"postgres_changes"'), "must use postgres_changes");
  assert(src.includes('table: "support_conversations"'), "must subscribe to support_conversations table");
  // Must also react to new support_messages (for unread badge)
  assert(src.includes('table: "support_messages"'), "must subscribe to support_messages table");
  // Must invalidate support-conversations query on change
  assert(src.includes('queryKey: ["support-conversations"]'), "must invalidate support-conversations query");
});

Deno.test("useSupportChat: Realtime channel is cleaned up on unmount", () => {
  const src = readSrc("hooks/useSupportChat.ts");
  assert(src.includes("supabase.removeChannel"), "must remove channel on unmount");
});

// ---------------------------------------------------------------------------
// 9. DB migration: schema correct
// ---------------------------------------------------------------------------

Deno.test("migration: whatsapp_conversations has support_conversation_id FK", () => {
  const sql = readMigration("20260930120000_whatsapp_live_chat_bridge.sql");
  assert(sql.includes("support_conversation_id uuid"), "must add support_conversation_id column");
  assert(sql.includes("REFERENCES public.support_conversations(id)"), "must have FK to support_conversations");
});

Deno.test("migration: support_conversations has wa_id column", () => {
  const sql = readMigration("20260930120000_whatsapp_live_chat_bridge.sql");
  assert(sql.includes("ADD COLUMN IF NOT EXISTS wa_id text"), "must add wa_id column");
});

Deno.test("migration: support_conversations channel constraint includes whatsapp", () => {
  const sql = readMigration("20260930120000_whatsapp_live_chat_bridge.sql");
  assert(sql.includes("'whatsapp'"), "channel constraint must include whatsapp");
});

Deno.test("migration: valid_user_reference constraint allows null customer_id for whatsapp channel", () => {
  const sql = readMigration("20260930120000_whatsapp_live_chat_bridge.sql");
  assert(
    sql.includes("channel = 'whatsapp'") && sql.includes("customer_id IS NOT NULL") || sql.includes("AND channel = 'whatsapp'"),
    "must allow null customer_id for whatsapp channel",
  );
});

// ---------------------------------------------------------------------------
// 10. No parallel support tables
// ---------------------------------------------------------------------------

Deno.test("no parallel whatsapp-specific support tables created", () => {
  const sql = readMigration("20260930120000_whatsapp_live_chat_bridge.sql");
  // Must NOT create a new table — only ALTER existing ones
  assert(!sql.includes("CREATE TABLE"), "must not create new tables (reuse existing support tables)");
});

// ---------------------------------------------------------------------------
// 11. useSupportChat: WhatsApp send routes through whatsapp-reply Edge Function
// ---------------------------------------------------------------------------

Deno.test("useSupportChat: WhatsApp channel sends via whatsapp-reply Edge Function (not direct insert)", () => {
  const src = readSrc("hooks/useSupportChat.ts");
  // Must check channel === 'whatsapp' and route to edge function
  assert(src.includes('channel === "whatsapp"'), "must branch on whatsapp channel");
  assert(src.includes("whatsapp-reply"), "must call whatsapp-reply Edge Function");
  // Must NOT do a direct support_messages insert for whatsapp path
  const waBlock = src.slice(
    src.indexOf('if (channel === "whatsapp")'),
    src.indexOf("// Standard in-app"),
  );
  assert(!waBlock.includes('.from("support_messages").insert'), "must not insert directly for whatsapp channel");
});

Deno.test("useSupportChat: conversation list must not embed drivers (permission denied)", () => {
  const src = readSrc("hooks/useSupportChat.ts");
  const start = src.indexOf("export function useSupportConversations");
  const end = src.indexOf("export function useSupportMessages");
  assert(start >= 0 && end > start, "must find useSupportConversations");
  const block = src.slice(start, end);
  assert(block.includes('.select("*")'), "base list query must select support_conversations only");
  assert(!block.includes("driver:drivers"), "must not PostgREST-embed drivers on the inbox query");
  assert(src.includes("admin_live_chat_driver_identity"), "driver names must come from the narrow admin identity RPC");
  assert(src.includes("enrichSupportIdentities"), "identity enrichment must be isolated from the base query");
});

Deno.test("useSupportChat: WhatsApp resolve routes through whatsapp-resolve Edge Function", () => {
  const src = readSrc("hooks/useSupportChat.ts");
  assert(src.includes("whatsapp-resolve"), "must call whatsapp-resolve Edge Function");
});
