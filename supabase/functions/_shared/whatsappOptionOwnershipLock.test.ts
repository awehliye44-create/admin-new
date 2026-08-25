/**
 * WhatsApp option ownership lock — Book / Track / Support must not mix transient state.
 *
 * If these fail, fix the code — never delete or soften the lock.
 *
 * Run:
 *   deno test supabase/functions/_shared/whatsappOptionOwnershipLock.test.ts --allow-read
 */

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildActiveTrackOwnershipPatch,
  buildBookOwnershipPatch,
  buildGenericTrackIdleOwnershipPatch,
  buildIdleOwnershipPatch,
  buildSupportOwnershipPatch,
} from "./whatsappOptionOwnership.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS = path.resolve(__dirname, "..");

function readShared(name: string): string {
  return fs.readFileSync(path.join(FUNCTIONS, "_shared", name), "utf8");
}
function readFunction(name: string): string {
  return fs.readFileSync(path.join(FUNCTIONS, name, "index.ts"), "utf8");
}

// ─── Runtime ownership helpers ───────────────────────────────────────────────

Deno.test("idle ownership clears all transient option fields", () => {
  assertEquals(buildIdleOwnershipPatch(), {
    workflow_state: "idle",
    booking_session_started_at: null,
    booking_session_expires_at: null,
    support_opened_at: null,
    support_conversation_id: null,
    active_trip_id: null,
  });
});

Deno.test("book ownership sets booking TTL and clears support (+ stale track when no trip)", () => {
  const patch = buildBookOwnershipPatch({
    nowIso: "2026-08-20T12:00:00.000Z",
    expiresAt: "2026-08-20T12:03:00.000Z",
    activeTripId: null,
  });
  assertEquals(patch.workflow_state, "book");
  assertEquals(patch.booking_session_started_at, "2026-08-20T12:00:00.000Z");
  assertEquals(patch.booking_session_expires_at, "2026-08-20T12:03:00.000Z");
  assertEquals(patch.support_opened_at, null);
  assertEquals(patch.support_conversation_id, null);
  assertEquals(patch.active_trip_id, null);
});

Deno.test("book ownership preserves genuine active_trip_id when present", () => {
  const patch = buildBookOwnershipPatch({
    nowIso: "2026-08-20T12:00:00.000Z",
    expiresAt: "2026-08-20T12:03:00.000Z",
    activeTripId: "trip-live-1",
  });
  assertEquals(patch.active_trip_id, "trip-live-1");
  assertEquals(patch.support_conversation_id, null);
});

Deno.test("active track ownership sets trip and clears support + booking TTL", () => {
  const patch = buildActiveTrackOwnershipPatch("trip-live-2");
  assertEquals(patch, {
    workflow_state: "track",
    active_trip_id: "trip-live-2",
    support_opened_at: null,
    support_conversation_id: null,
    booking_session_started_at: null,
    booking_session_expires_at: null,
  });
});

Deno.test("generic track returns idle ownership (not sticky track)", () => {
  assertEquals(buildGenericTrackIdleOwnershipPatch(), buildIdleOwnershipPatch());
});

Deno.test("support ownership sets support fields and clears booking TTL (keeps trip key absent)", () => {
  const patch = buildSupportOwnershipPatch({
    nowIso: "2026-08-20T12:00:00.000Z",
    supportConversationId: "supp-1",
  });
  assertEquals(patch.workflow_state, "support");
  assertEquals(patch.support_opened_at, "2026-08-20T12:00:00.000Z");
  assertEquals(patch.support_conversation_id, "supp-1");
  assertEquals(patch.booking_session_started_at, null);
  assertEquals(patch.booking_session_expires_at, null);
  assert(!("active_trip_id" in patch), "must not clear genuine active_trip_id on support entry");
});

// ─── Source wiring: entry uses ownership helpers after successful send ────────

Deno.test("sendBookContinuation uses buildBookOwnershipPatch only after send ok", () => {
  const src = readShared("whatsappWorkflow.ts");
  const fnStart = src.indexOf("async function sendBookContinuation");
  const fnEnd = src.indexOf("async function sendTrackContinuation");
  const body = src.slice(fnStart, fnEnd);
  assert(body.includes('if (!sent.ok) return "book_link_send_failed"'));
  const failIdx = body.indexOf('return "book_link_send_failed"');
  const patchIdx = body.indexOf("buildBookOwnershipPatch");
  assert(patchIdx > failIdx, "book ownership must advance only after send success");
  assert(body.includes("support_opened_at: null") || body.includes("buildBookOwnershipPatch"));
});

Deno.test("sendTrackContinuation: active uses track patch; generic uses idle patch; fail does not advance", () => {
  const src = readShared("whatsappWorkflow.ts");
  const fnStart = src.indexOf("async function sendTrackContinuation");
  const fnEnd = src.indexOf("async function openSupportState");
  const body = src.slice(fnStart, fnEnd);
  assert(body.includes('if (!trackSent.ok) return "track_link_send_failed"'));
  const failIdx = body.indexOf('return "track_link_send_failed"');
  assert(body.indexOf("buildActiveTrackOwnershipPatch") > failIdx);
  assert(body.indexOf("buildGenericTrackIdleOwnershipPatch") > failIdx);
  assert(body.includes('return "track_link_generic"'));
  assert(body.includes('return "track_link_active_trip"'));
});

Deno.test("openSupportState uses buildSupportOwnershipPatch only after ACK send ok", () => {
  const src = readShared("whatsappWorkflow.ts");
  const fnStart = src.indexOf("async function openSupportState");
  const fnEnd = src.indexOf("async function cancelBookingSession");
  const body = src.slice(fnStart, fnEnd);
  assert(body.includes('if (!sent.ok) return "support_send_failed"'));
  const failIdx = body.indexOf('return "support_send_failed"');
  assert(body.indexOf("buildSupportOwnershipPatch") > failIdx);
});

Deno.test("support→book/track routes through sendBookContinuation/sendTrackContinuation (clears support linkage)", () => {
  const src = readShared("whatsappWorkflow.ts");
  const supportBlock = src.slice(
    src.indexOf('if (conversation.workflow_state === "support")'),
    src.indexOf('if (conversation.workflow_state === "book")'),
  );
  assert(supportBlock.includes('if (intent === "book") return sendBookContinuation'));
  assert(supportBlock.includes('if (intent === "track") return sendTrackContinuation'));
  assert(supportBlock.includes("buildIdleOwnershipPatch"));
});

Deno.test("book→track/support/menu use ownership transitions", () => {
  const src = readShared("whatsappWorkflow.ts");
  const bookBlock = src.slice(
    src.indexOf('if (conversation.workflow_state === "book")'),
    src.indexOf("// ── 4. Standard state machine"),
  );
  assert(bookBlock.includes("cancelBookingSession"));
  assert(bookBlock.includes("sendTrackContinuation"));
  assert(bookBlock.includes("openSupportState"));
});

Deno.test("live track sticky requires active_trip_id; generic track does not stay sticky", () => {
  const src = readShared("whatsappWorkflow.ts");
  assert(src.includes('conversation.workflow_state === "track"'));
  assert(src.includes("conversation.active_trip_id != null"));
  assert(src.includes("buildGenericTrackIdleOwnershipPatch"));
});

Deno.test("menu / unknown idle paths use buildIdleOwnershipPatch", () => {
  const src = readShared("whatsappWorkflow.ts");
  assert(src.includes("buildIdleOwnershipPatch()"));
  const menuHits = (src.match(/buildIdleOwnershipPatch\(\)/g) ?? []).length;
  assert(menuHits >= 4, `expected multiple idle ownership uses, got ${menuHits}`);
});

Deno.test("cancelBookingSession resets via buildIdleOwnershipPatch", () => {
  const src = readShared("whatsappWorkflow.ts");
  const fnStart = src.indexOf("async function cancelBookingSession");
  const fnEnd = src.indexOf("export async function processWhatsAppInboundMessage");
  const body = src.slice(fnStart, fnEnd);
  assert(body.includes("buildIdleOwnershipPatch()"));
  assert(body.includes('return ok ? "booking_cancelled_menu" : "booking_cancelled"'));
});

Deno.test("whatsapp-resolve clears by support_conversation_id then idles support rows", () => {
  const src = readFunction("whatsapp-resolve");
  assert(src.includes('.eq("support_conversation_id", convId)'));
  assert(src.includes("support_opened_at: null"));
  assert(src.includes("support_conversation_id: null"));
  assert(src.includes('.eq("workflow_state", "support")'));
});

Deno.test("book expiry cron still resets book → idle without inventing second SM", () => {
  const expire = readFunction("whatsapp-session-expire");
  assert(expire.includes('workflow_state: "idle"'));
  assert(expire.includes("booking_session_started_at: null"));
  assert(expire.includes("booking_session_expires_at: null"));
  assert(expire.includes('.eq("workflow_state", "book")'));
});

Deno.test("ownership helpers are the single patch SSOT used by option entry", () => {
  const ownership = readShared("whatsappOptionOwnership.ts");
  const workflow = readShared("whatsappWorkflow.ts");
  assert(ownership.includes("export function buildBookOwnershipPatch"));
  assert(ownership.includes("export function buildActiveTrackOwnershipPatch"));
  assert(ownership.includes("export function buildGenericTrackIdleOwnershipPatch"));
  assert(ownership.includes("export function buildSupportOwnershipPatch"));
  assert(ownership.includes("export function buildIdleOwnershipPatch"));
  assert(workflow.includes('from "./whatsappOptionOwnership.ts"'));
});
