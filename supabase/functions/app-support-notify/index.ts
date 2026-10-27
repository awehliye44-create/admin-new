/**
 * app-support-notify
 *
 * Admin/service push when an in_app Live Chat message is sent or the chat is
 * closed ("Close & notify"). Reuses send-customer-notification /
 * send-driver-notification.
 *
 * POST { conversation_id, kind: 'reply' | 'closed' }
 * Auth: admin JWT or service role.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { requireAdminOrService } from "../_shared/callerGate.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  const gate = await requireAdminOrService(req);
  if (!gate.ok) return gate.response;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "INVALID_JSON" }, 400);
  }

  const conversationId = String(body.conversation_id ?? "").trim();
  const kind = String(body.kind ?? "reply").trim().toLowerCase();
  if (!conversationId) return json({ error: "CONVERSATION_REQUIRED" }, 400);

  const { data: conv, error } = await admin
    .from("support_conversations")
    .select("id, subject, user_type, customer_id, driver_id, channel, status")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw error;
  if (!conv) return json({ error: "NOT_FOUND" }, 404);
  if (conv.channel !== "in_app") {
    return json({ error: "NOT_IN_APP_CHANNEL" }, 400);
  }

  if (kind === "closed") {
    await admin
      .from("support_conversations")
      .update({
        status: "closed",
        resolved_at: new Date().toISOString(),
      })
      .eq("id", conv.id);
  }

  const title =
    kind === "closed" ? "Support chat closed" : "New reply from ONECAB Support";
  const bodyText =
    kind === "closed"
      ? "Your support chat was closed. You can still read the history or start a new chat."
      : `Reply on: ${conv.subject || "your support chat"}`;

  const path =
    conv.user_type === "driver"
      ? `/help-support/live-chat/${conv.id}`
      : `/account/live-chat/${conv.id}`;

  const data = {
    type: "support_chat",
    conversation_id: conv.id,
    kind,
    path,
  };

  if (conv.user_type === "customer" && conv.customer_id) {
    const { error: notifyErr } = await admin.functions.invoke(
      "send-customer-notification",
      {
        body: {
          customer_id: conv.customer_id,
          title,
          body: bodyText,
          type: "support_chat",
          data,
        },
      },
    );
    if (notifyErr) {
      console.error("[app-support-notify] customer", notifyErr.message);
    }
  } else if (conv.user_type === "driver" && conv.driver_id) {
    const { error: notifyErr } = await admin.functions.invoke(
      "send-driver-notification",
      {
        body: {
          driverId: conv.driver_id,
          type: "SYSTEM_ALERT",
          title,
          body: bodyText,
          data,
        },
      },
    );
    if (notifyErr) {
      console.error("[app-support-notify] driver", notifyErr.message);
    }
  }

  return json({ ok: true });
});
