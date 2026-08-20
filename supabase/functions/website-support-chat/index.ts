/**
 * website-support-chat
 *
 * Public (anon-key) endpoint used by the onecab.net website support widget.
 * Reuses the EXISTING Admin Live Chat backend (support_conversations /
 * support_messages) — no separate support system.
 *
 * Guest sessions are identified by an opaque `session_token` minted here and
 * stored in the visitor's browser. All writes go through the service role;
 * the website never touches the tables directly.
 *
 * Actions (POST JSON { action, ... }):
 *  - start   { name?, email?, message } -> { session_token, conversation_id }
 *  - send    { session_token, message } -> { ok: true }
 *  - poll    { session_token, since? }  -> { status, messages[] }
 *
 * Availability is gated by admin-support-status (separate endpoint); this
 * function additionally refuses to open NEW conversations when no admin is
 * available so the widget can never create an orphan chat.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const HEARTBEAT_STALE_MS = 2 * 60 * 1000;
const MAX_MESSAGE_LEN = 2000;

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function clean(v: unknown, max: number): string {
  return String(v ?? "").trim().slice(0, max);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "INVALID_JSON" }, 400);
  }

  const action = clean(body.action, 20).toLowerCase();

  try {
    if (action === "start") {
      const message = clean(body.message, MAX_MESSAGE_LEN);
      if (!message) return json({ error: "MESSAGE_REQUIRED" }, 400);

      // Fail closed: no live admin -> no new website conversation.
      const { data: presence } = await supabase
        .from("admin_support_availability")
        .select("last_heartbeat_at")
        .eq("id", "singleton")
        .maybeSingle();
      const fresh = presence?.last_heartbeat_at
        ? Date.now() - new Date(presence.last_heartbeat_at).getTime() < HEARTBEAT_STALE_MS
        : false;
      if (!fresh) return json({ error: "SUPPORT_UNAVAILABLE" }, 409);

      const name = clean(body.name, 120);
      const email = clean(body.email, 200);
      const sessionToken = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");

      const { data: conv, error: convErr } = await supabase
        .from("support_conversations")
        .insert({
          subject: name ? `Website chat — ${name}` : "Website chat",
          status: "open",
          priority: "normal",
          channel: "website",
          initiated_by: "user",
          user_type: "customer",
          customer_id: null,
          guest_session_token: sessionToken,
          guest_name: name || null,
          guest_email: email || null,
        })
        .select("id")
        .single();
      if (convErr) throw convErr;

      const { error: msgErr } = await supabase.from("support_messages").insert({
        conversation_id: conv.id,
        sender_type: "customer",
        sender_id: null,
        content: message,
        content_type: "text",
        is_read: false,
      });
      if (msgErr) throw msgErr;

      await supabase
        .from("support_conversations")
        .update({ last_message_at: new Date().toISOString() })
        .eq("id", conv.id);

      return json({ ok: true, session_token: sessionToken, conversation_id: conv.id });
    }

    const sessionToken = clean(body.session_token, 200);
    if (!sessionToken) return json({ error: "SESSION_REQUIRED" }, 400);

    const { data: conv, error: lookupErr } = await supabase
      .from("support_conversations")
      .select("id, status")
      .eq("guest_session_token", sessionToken)
      .eq("channel", "website")
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!conv) return json({ error: "SESSION_NOT_FOUND" }, 404);

    if (action === "send") {
      const message = clean(body.message, MAX_MESSAGE_LEN);
      if (!message) return json({ error: "MESSAGE_REQUIRED" }, 400);
      if (conv.status === "closed" || conv.status === "resolved") {
        return json({ error: "CONVERSATION_CLOSED" }, 409);
      }

      const { error: msgErr } = await supabase.from("support_messages").insert({
        conversation_id: conv.id,
        sender_type: "customer",
        sender_id: null,
        content: message,
        content_type: "text",
        is_read: false,
      });
      if (msgErr) throw msgErr;

      await supabase
        .from("support_conversations")
        .update({ last_message_at: new Date().toISOString(), status: "open" })
        .eq("id", conv.id);

      return json({ ok: true });
    }

    if (action === "poll") {
      const since = clean(body.since, 40);
      let q = supabase
        .from("support_messages")
        .select("id, sender_type, content, created_at")
        .eq("conversation_id", conv.id)
        .order("created_at", { ascending: true })
        .limit(200);
      if (since) q = q.gt("created_at", since);
      const { data: messages, error: msgErr } = await q;
      if (msgErr) throw msgErr;

      return json({
        ok: true,
        status: conv.status,
        conversation_id: conv.id,
        messages: (messages ?? []).map((m) => ({
          id: m.id,
          from: m.sender_type === "admin" ? "admin" : m.sender_type,
          content: m.content,
          created_at: m.created_at,
        })),
      });
    }

    return json({ error: "UNKNOWN_ACTION" }, 400);
  } catch (e) {
    console.error("[website-support-chat]", (e as Error).message);
    return json({ error: "SUPPORT_CHAT_FAILED" }, 500);
  }
});
