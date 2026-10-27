/**
 * app-support-chat
 *
 * Authenticated Customer / Driver Live Chat into the EXISTING Admin Live Chat
 * tables (support_conversations / support_messages). channel = 'in_app'.
 *
 * Actions (POST JSON { action, ... }, Authorization: Bearer <user JWT>):
 *  - start   { subject, message } -> { conversation_id }
 *  - send    { conversation_id, message } -> { ok: true }
 *  - list    {} -> { conversations[] }
 *  - messages { conversation_id, since? } -> { status, messages[] }
 *  - close   { conversation_id } -> { ok: true }
 *
 * Suspended / disabled accounts may still chat (JWT + customer/driver row).
 * Users may only access their own conversations.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_MESSAGE_LEN = 2000;

const CUSTOMER_SUBJECTS = new Set([
  "Booking or trip",
  "Payment or refund",
  "Lost property",
  "Account suspension",
  "Other",
]);

const DRIVER_SUBJECTS = new Set([
  "Trips or offers",
  "Documents",
  "Wallet or earnings",
  "Account suspension",
  "Other",
]);

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function clean(v: unknown, max: number): string {
  return String(v ?? "").trim().slice(0, max);
}

type Actor =
  | { kind: "customer"; id: string; label: string }
  | { kind: "driver"; id: string; label: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer || bearer === anonKey) {
    return json({ error: "AUTH_REQUIRED" }, 401);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${bearer}` } },
    auth: { persistSession: false },
  });
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const { data: authData, error: authErr } = await userClient.auth.getUser();
  const userId = authData.user?.id ?? null;
  if (authErr || !userId) return json({ error: "AUTH_REQUIRED" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "INVALID_JSON" }, 400);
  }

  const action = clean(body.action, 20).toLowerCase();

  try {
    const actor = await resolveActor(admin, userId);
    if (!actor) return json({ error: "PROFILE_NOT_FOUND" }, 403);

    if (action === "start") {
      const subjectRaw = clean(body.subject, 80);
      const message = clean(body.message, MAX_MESSAGE_LEN);
      if (!message) return json({ error: "MESSAGE_REQUIRED" }, 400);

      const allow =
        actor.kind === "customer" ? CUSTOMER_SUBJECTS : DRIVER_SUBJECTS;
      if (!allow.has(subjectRaw)) {
        return json({ error: "INVALID_SUBJECT" }, 400);
      }

      const roleTag = actor.kind === "customer" ? "Customer" : "Driver";
      const subject = `${roleTag}: ${subjectRaw}`;

      const insert: Record<string, unknown> = {
        subject,
        status: "open",
        priority: "normal",
        channel: "in_app",
        initiated_by: "user",
        user_type: actor.kind,
        category: subjectRaw,
        tags: [actor.kind, "in_app", subjectRaw],
        last_message_at: new Date().toISOString(),
      };
      if (actor.kind === "customer") {
        insert.customer_id = actor.id;
        insert.driver_id = null;
      } else {
        insert.driver_id = actor.id;
        insert.customer_id = null;
      }

      const { data: conv, error: convErr } = await admin
        .from("support_conversations")
        .insert(insert)
        .select("id")
        .single();
      if (convErr) throw convErr;

      const { error: msgErr } = await admin.from("support_messages").insert({
        conversation_id: conv.id,
        sender_type: actor.kind,
        sender_id: userId,
        content: message,
        content_type: "text",
        is_read: false,
      });
      if (msgErr) throw msgErr;

      return json({
        ok: true,
        conversation_id: conv.id,
        subject,
        user_type: actor.kind,
      });
    }

    if (action === "list") {
      let q = admin
        .from("support_conversations")
        .select(
          "id, subject, status, category, last_message_at, created_at, resolved_at, user_type",
        )
        .eq("channel", "in_app")
        .eq("user_type", actor.kind)
        .order("last_message_at", { ascending: false })
        .limit(50);
      if (actor.kind === "customer") q = q.eq("customer_id", actor.id);
      else q = q.eq("driver_id", actor.id);

      const { data: rows, error: listErr } = await q;
      if (listErr) throw listErr;

      return json({
        ok: true,
        conversations: (rows ?? []).map((r) => ({
          id: r.id,
          subject: r.subject,
          category: r.category,
          status: r.status,
          user_type: r.user_type,
          last_message_at: r.last_message_at,
          created_at: r.created_at,
          resolved_at: r.resolved_at,
        })),
      });
    }

    const conversationId = clean(body.conversation_id, 40);
    if (!conversationId) return json({ error: "CONVERSATION_REQUIRED" }, 400);

    const { data: conv, error: lookupErr } = await admin
      .from("support_conversations")
      .select(
        "id, status, subject, user_type, customer_id, driver_id, channel, last_message_at, created_at, resolved_at",
      )
      .eq("id", conversationId)
      .eq("channel", "in_app")
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!conv) return json({ error: "NOT_FOUND" }, 404);
    if (!ownsConversation(actor, conv)) return json({ error: "FORBIDDEN" }, 403);

    if (action === "send") {
      const message = clean(body.message, MAX_MESSAGE_LEN);
      if (!message) return json({ error: "MESSAGE_REQUIRED" }, 400);
      if (conv.status === "closed" || conv.status === "resolved") {
        return json({ error: "CONVERSATION_CLOSED" }, 409);
      }

      const { error: msgErr } = await admin.from("support_messages").insert({
        conversation_id: conv.id,
        sender_type: actor.kind,
        sender_id: userId,
        content: message,
        content_type: "text",
        is_read: false,
      });
      if (msgErr) throw msgErr;

      await admin
        .from("support_conversations")
        .update({
          last_message_at: new Date().toISOString(),
          status: "open",
        })
        .eq("id", conv.id);

      return json({ ok: true });
    }

    if (action === "messages") {
      const since = clean(body.since, 40);
      let q = admin
        .from("support_messages")
        .select("id, sender_type, content, created_at, is_read")
        .eq("conversation_id", conv.id)
        .order("created_at", { ascending: true })
        .limit(300);
      if (since) q = q.gt("created_at", since);
      const { data: messages, error: msgErr } = await q;
      if (msgErr) throw msgErr;

      // Mark admin messages as read for this user.
      await admin
        .from("support_messages")
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq("conversation_id", conv.id)
        .eq("sender_type", "admin")
        .eq("is_read", false);

      return json({
        ok: true,
        status: conv.status,
        subject: conv.subject,
        conversation_id: conv.id,
        messages: (messages ?? []).map((m) => ({
          id: m.id,
          from: m.sender_type === "admin" ? "admin" : m.sender_type,
          content: m.content,
          created_at: m.created_at,
        })),
      });
    }

    if (action === "close") {
      const { error: upErr } = await admin
        .from("support_conversations")
        .update({
          status: "closed",
          resolved_at: new Date().toISOString(),
        })
        .eq("id", conv.id);
      if (upErr) throw upErr;
      return json({ ok: true });
    }

    return json({ error: "UNKNOWN_ACTION" }, 400);
  } catch (e) {
    console.error("[app-support-chat]", (e as Error).message);
    return json({ error: "SUPPORT_CHAT_FAILED" }, 500);
  }
});

async function resolveActor(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<Actor | null> {
  const { data: customer } = await admin
    .from("customers")
    .select("id, first_name, last_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (customer?.id) {
    const name = `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim();
    return { kind: "customer", id: customer.id, label: name || "Customer" };
  }

  const { data: driver } = await admin
    .from("drivers")
    .select("id, first_name, last_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (driver?.id) {
    const name = `${driver.first_name ?? ""} ${driver.last_name ?? ""}`.trim();
    return { kind: "driver", id: driver.id, label: name || "Driver" };
  }

  return null;
}

function ownsConversation(
  actor: Actor,
  conv: { customer_id: string | null; driver_id: string | null; user_type: string },
): boolean {
  if (actor.kind === "customer") {
    return conv.user_type === "customer" && conv.customer_id === actor.id;
  }
  return conv.user_type === "driver" && conv.driver_id === actor.id;
}
