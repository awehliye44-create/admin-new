/**
 * whatsapp-session-expire — Sweep expired WhatsApp booking sessions.
 *
 * Called by pg_cron every ~1 minute via pg_net.http_post (service-role).
 * Also accepts POST with service-role Bearer for manual invocation / testing.
 *
 * For each whatsapp_conversations row where:
 *   workflow_state = 'book'
 *   AND booking_session_expires_at <= now()
 *
 * Atomically claims the row with an UPDATE ... WHERE workflow_state='book' guard
 * (prevents duplicate expiry sends on concurrent invocations), then:
 *   1. Sends exactly one expiry notification to the customer.
 *   2. Resets workflow_state = 'idle', clears booking_session_* timestamps.
 *
 * NEVER:
 *   - Cancels or modifies a real trip.
 *   - Closes an independently open support conversation.
 *   - Deletes the customer or any WhatsApp conversation row.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  readWhatsAppSendCredentials,
  sendWhatsAppTextMessage,
} from "../_shared/whatsappOutbound.ts";

const EXPIRY_MESSAGE =
  "*ONECAB*\nYour booking session has expired.\n\nPlease start a new booking if you still need a ride.";

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
  if (!supabaseUrl || !serviceKey) return json({ error: "db_unconfigured" }, 503);

  // Auth: service-role Bearer only (pg_cron caller) or any valid JWT.
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();

  let okAuth = bearer === serviceKey;
  if (!okAuth && bearer.split(".").length === 3) {
    try {
      const payload = JSON.parse(atob(bearer.split(".")[1]!));
      if (payload?.role === "service_role") okAuth = true;
    } catch { /* ignore */ }
  }
  if (!okAuth) return json({ error: "unauthorized" }, 401);

  const svcClient = createClient(supabaseUrl, serviceKey);
  const creds = readWhatsAppSendCredentials();
  if (!creds) return json({ error: "outbound_unconfigured" }, 503);

  const nowIso = new Date().toISOString();

  // ── Find expired booking sessions.
  const { data: expired, error: fetchErr } = await svcClient
    .from("whatsapp_conversations")
    .select("wa_id, workflow_state, booking_session_expires_at, support_conversation_id")
    .eq("workflow_state", "book")
    .lte("booking_session_expires_at", nowIso)
    .not("booking_session_expires_at", "is", null)
    .limit(50);

  if (fetchErr) {
    console.error("[whatsapp-session-expire] fetch failed", fetchErr.message);
    return json({ error: "fetch_failed" }, 500);
  }

  const rows = expired ?? [];
  const results: { wa_id_suffix: string; result: string }[] = [];

  for (const row of rows) {
    const waId = row.wa_id as string;

    // ── Atomic claim: only proceed if row is still in 'book' state.
    //    The WHERE workflow_state='book' guard prevents duplicate expiry sends
    //    if two sweep invocations overlap.
    const { data: claimed, error: claimErr } = await svcClient
      .from("whatsapp_conversations")
      .update({
        workflow_state: "idle",
        booking_session_started_at: null,
        booking_session_expires_at: null,
        updated_at: nowIso,
      })
      .eq("wa_id", waId)
      .eq("workflow_state", "book")
      .select("wa_id")
      .single();

    if (claimErr || !claimed) {
      // Already claimed by a concurrent invocation — skip.
      results.push({ wa_id_suffix: waId.slice(-6), result: "already_claimed" });
      continue;
    }

    // ── Send expiry notification.
    const sendResult = await sendWhatsAppTextMessage(creds, waId, EXPIRY_MESSAGE);
    results.push({
      wa_id_suffix: waId.slice(-6),
      result: sendResult.ok ? "expired_notified" : `expired_notify_failed_${sendResult.status}`,
    });

    if (!sendResult.ok) {
      console.error("[whatsapp-session-expire] expiry notify failed", {
        wa_id_suffix: waId.slice(-6),
        status: sendResult.status,
      });
    }
  }

  return json({ ok: true, swept: results.length, results });
});
