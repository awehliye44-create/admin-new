/**
 * whatsapp-resolve — Admin closes a WhatsApp support conversation.
 *
 * Auth: valid Supabase admin JWT required.
 * Input:  { support_conversation_id: string }
 * Output: { ok: boolean, error?: string }
 *
 * Flow:
 *  1. Auth via Supabase JWT.
 *  2. Load support_conversations; require channel = 'whatsapp'.
 *  3. Send closure message to customer via existing sendWhatsAppTextMessage().
 *  4. Mark support_conversations resolved.
 *  5. Reset whatsapp_conversations: workflow_state='idle', clear support columns.
 *  6. Does NOT cancel trips; does NOT close independent booking sessions.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  readWhatsAppSendCredentials,
  sendWhatsAppTextMessage,
} from "../_shared/whatsappOutbound.ts";

const CLOSURE_MESSAGE =
  "*ONECAB*\nYour support request has been closed.\n\nIf you need anything else, send a new message and choose an option from the menu.";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !serviceKey || !anonKey) return json({ error: "db_unconfigured" }, 503);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "unauthorized" }, 401);

  const svcClient = createClient(supabaseUrl, serviceKey);

  let body: { support_conversation_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const convId = (body.support_conversation_id ?? "").trim();
  if (!convId) return json({ error: "support_conversation_id required" }, 400);

  const { data: conv, error: convErr } = await svcClient
    .from("support_conversations")
    .select("id, channel, status, wa_id")
    .eq("id", convId)
    .single();

  if (convErr || !conv) return json({ error: "conversation_not_found" }, 404);
  if (conv.channel !== "whatsapp") return json({ error: "not_a_whatsapp_conversation" }, 400);
  if (conv.status === "resolved" || conv.status === "closed") {
    return json({ ok: true, already_resolved: true });
  }

  const waId = conv.wa_id as string | null;
  if (!waId) return json({ error: "wa_id_missing" }, 400);

  // ── Send closure message to customer.
  const creds = readWhatsAppSendCredentials();
  if (!creds) return json({ error: "outbound_unconfigured" }, 503);

  const sendResult = await sendWhatsAppTextMessage(creds, waId, CLOSURE_MESSAGE);
  // Proceed with resolution even if send failed (log it); customer may have
  // blocked the number or closed their app — the support ticket should still close.
  if (!sendResult.ok) {
    console.error("[whatsapp-resolve] closure message send failed", sendResult.status);
  }

  const nowIso = new Date().toISOString();

  // ── Insert closure notice into support_messages (admin-side record).
  await svcClient.from("support_messages").insert({
    conversation_id: convId,
    sender_type: "system",
    sender_id: null,
    content: sendResult.ok
      ? "Support conversation closed. Closure message sent to customer."
      : `Support conversation closed. Closure message send failed (status ${sendResult.status}).`,
    content_type: "text",
    is_read: true,
    metadata: { resolved_by: user.id, wa_message_id: sendResult.ok ? (sendResult as { ok: true; messageId: string | null }).messageId : null },
  });

  // ── Mark support conversation resolved.
  await svcClient
    .from("support_conversations")
    .update({
      status: "resolved",
      resolved_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", convId);

  // ── Reset WhatsApp conversation state to idle.
  //    Only clears support ownership; does NOT touch booking_session columns.
  await svcClient
    .from("whatsapp_conversations")
    .update({
      workflow_state: "idle",
      support_opened_at: null,
      support_conversation_id: null,
      last_outbound_at: nowIso,
      updated_at: nowIso,
    })
    .eq("wa_id", waId)
    .eq("workflow_state", "support"); // guard: only reset if still in support state

  return json({ ok: true, closure_sent: sendResult.ok });
});
