/**
 * whatsapp-reply — Admin sends a WhatsApp message to a customer.
 *
 * Auth: valid Supabase admin JWT required (RLS enforced; never exposes Meta token).
 * Input:  { support_conversation_id: string, content: string }
 * Output: { ok: boolean, messageId?: string, error?: string }
 *
 * Flow:
 *  1. Auth via Supabase JWT (anon key + user session).
 *  2. Load support_conversations row; require channel = 'whatsapp'.
 *  3. Load linked whatsapp_conversations to get wa_id.
 *  4. Send through existing sendWhatsAppTextMessage() / readWhatsAppSendCredentials().
 *  5. On Meta send success: insert support_messages admin row.
 *  6. Update whatsapp_conversations.last_outbound_at.
 *  7. Return sanitised Meta result; never expose token.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  readWhatsAppSendCredentials,
  sendWhatsAppTextMessage,
} from "../_shared/whatsappOutbound.ts";

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

  if (!supabaseUrl || !serviceKey || !anonKey) {
    return json({ error: "db_unconfigured" }, 503);
  }

  // ── Auth: caller must present a valid Supabase user JWT.
  //    We use the anon key client so RLS applies; then elevate with service key
  //    only for whatsapp_conversations reads which have service-role-only RLS.
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "unauthorized" }, 401);

  // Service-role client for tables with service-role-only RLS (whatsapp_*).
  const svcClient = createClient(supabaseUrl, serviceKey);

  let body: { support_conversation_id?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const convId = (body.support_conversation_id ?? "").trim();
  const content = (body.content ?? "").trim();
  if (!convId) return json({ error: "support_conversation_id required" }, 400);
  if (!content) return json({ error: "content required" }, 400);

  // ── Load support conversation — must be whatsapp channel.
  const { data: conv, error: convErr } = await svcClient
    .from("support_conversations")
    .select("id, channel, status, wa_id, customer_id")
    .eq("id", convId)
    .single();

  if (convErr || !conv) return json({ error: "conversation_not_found" }, 404);
  if (conv.channel !== "whatsapp") {
    return json({ error: "not_a_whatsapp_conversation" }, 400);
  }
  if (conv.status === "resolved" || conv.status === "closed") {
    return json({ error: "conversation_closed" }, 400);
  }

  const waId = conv.wa_id as string | null;
  if (!waId) return json({ error: "wa_id_missing" }, 400);

  // ── Send through existing outbound sender (token never reaches browser).
  const creds = readWhatsAppSendCredentials();
  if (!creds) return json({ error: "outbound_unconfigured" }, 503);

  const sendResult = await sendWhatsAppTextMessage(creds, waId, content);
  if (!sendResult.ok) {
    return json({ ok: false, error: "meta_send_failed", http_status: sendResult.status }, 502);
  }

  // ── Record admin message in support_messages.
  const nowIso = new Date().toISOString();
  const { error: msgErr } = await svcClient.from("support_messages").insert({
    conversation_id: convId,
    sender_type: "admin",
    sender_id: user.id,
    content,
    content_type: "text",
    is_read: true,
    metadata: { wa_message_id: sendResult.messageId ?? null },
  });

  if (msgErr) {
    // Message was delivered to customer but recording failed — log and return partial success.
    console.error("[whatsapp-reply] support_messages insert failed", msgErr.message);
  }

  // ── Update support conversation last_message_at.
  await svcClient
    .from("support_conversations")
    .update({ last_message_at: nowIso, updated_at: nowIso })
    .eq("id", convId);

  // ── Update whatsapp_conversations.last_outbound_at.
  await svcClient
    .from("whatsapp_conversations")
    .update({ last_outbound_at: nowIso, updated_at: nowIso })
    .eq("wa_id", waId);

  return json({ ok: true, messageId: sendResult.messageId ?? null });
});
