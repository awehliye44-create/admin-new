/**
 * whatsapp-booking-out-of-area-notify
 *
 * Sends ONE professional WhatsApp message when a verified booking continuation
 * pickup is authoritatively OUTSIDE_AREA.
 *
 * - Requires a valid signed WhatsApp book continuation token (wa_id from token).
 * - Does NOT change the welcome / 3-option menu.
 * - Dedupes per wa_id via whatsapp_conversations.metadata (24h window).
 * - Stamps the dedupe key only AFTER a successful Graph send (failed delivery can retry).
 * - Never invents coverage — caller must already have OUTSIDE_AREA from resolve-service-area.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { corsHeaders } from "../_shared/corsHeaders.ts";
import {
  buildWhatsAppContinuationSigningMaterial,
  verifyWhatsAppContinuationToken,
} from "../_shared/whatsappContinuationToken.ts";
import {
  readWhatsAppSendCredentials,
  sendWhatsAppTextMessage,
} from "../_shared/whatsappOutbound.ts";
import {
  OUT_OF_AREA_NOTICE_META_KEY,
  shouldSendOutOfAreaNotice,
  WHATSAPP_OUT_OF_AREA_NOTICE_TEXT,
  withOutOfAreaNoticeSent,
} from "../_shared/whatsappOutOfAreaNotice.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const respond = (status: number, payload: Record<string, unknown>) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const body = (await req.json().catch(() => ({}))) as {
      continuation_token?: unknown;
      code?: unknown;
    };

    // Only accept positive authoritative OUTSIDE_AREA — never send on technical failure.
    if (body.code !== "OUTSIDE_AREA") {
      return respond(400, {
        success: false,
        error: "OUTSIDE_AREA_REQUIRED",
        sent: false,
      });
    }

    const token =
      typeof body.continuation_token === "string" ? body.continuation_token.trim() : "";
    if (!token) {
      return respond(400, {
        success: false,
        error: "CONTINUATION_TOKEN_REQUIRED",
        sent: false,
      });
    }

    const verifyToken = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN")?.trim() ?? "";
    const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")?.trim() ?? "";
    if (!verifyToken || !phoneNumberId) {
      return respond(503, {
        success: false,
        error: "WHATSAPP_SIGNING_UNAVAILABLE",
        sent: false,
      });
    }

    const claims = await verifyWhatsAppContinuationToken(
      token,
      buildWhatsAppContinuationSigningMaterial({ verifyToken, phoneNumberId }),
    );
    if (!claims || claims.purpose !== "book") {
      return respond(401, {
        success: false,
        error: "INVALID_CONTINUATION_TOKEN",
        sent: false,
      });
    }

    const waId = claims.waId.trim();
    if (!waId) {
      return respond(401, {
        success: false,
        error: "INVALID_CONTINUATION_TOKEN",
        sent: false,
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: conversation, error: convErr } = await supabase
      .from("whatsapp_conversations")
      .select("wa_id, metadata")
      .eq("wa_id", waId)
      .maybeSingle();
    if (convErr) throw new Error(convErr.message);

    const metadata = conversation?.metadata ?? {};
    if (!shouldSendOutOfAreaNotice(metadata)) {
      return respond(200, {
        success: true,
        sent: false,
        deduped: true,
      });
    }

    const creds = readWhatsAppSendCredentials();
    if (!creds) {
      return respond(503, {
        success: false,
        error: "WHATSAPP_CREDENTIALS_UNAVAILABLE",
        sent: false,
      });
    }

    // Send first. Only stamp the dedupe key after Meta accepts the message so a
    // failed delivery can still be retried (client sessionStorage still blocks remount spam).
    const result = await sendWhatsAppTextMessage(
      creds,
      waId,
      WHATSAPP_OUT_OF_AREA_NOTICE_TEXT,
    );

    if (!result.ok) {
      console.error("[whatsapp-booking-out-of-area-notify] send failed", {
        status: result.status,
        error: result.error,
      });
      return respond(200, {
        success: true,
        sent: false,
        deduped: false,
        delivery: "failed",
      });
    }

    const sentAtIso = new Date().toISOString();
    const nextMetadata = withOutOfAreaNoticeSent(metadata, sentAtIso);

    if (conversation) {
      const { error: updateErr } = await supabase
        .from("whatsapp_conversations")
        .update({
          metadata: nextMetadata,
          last_outbound_at: sentAtIso,
          updated_at: sentAtIso,
        })
        .eq("wa_id", waId);
      if (updateErr) {
        // Message already delivered — log but still report sent to avoid client retries.
        console.error("[whatsapp-booking-out-of-area-notify] dedupe stamp failed", updateErr.message);
      }
    } else {
      const { error: insertErr } = await supabase.from("whatsapp_conversations").insert({
        wa_id: waId,
        workflow_state: "book",
        metadata: nextMetadata,
        last_outbound_at: sentAtIso,
        updated_at: sentAtIso,
      });
      if (insertErr && String(insertErr.code) !== "23505") {
        console.error("[whatsapp-booking-out-of-area-notify] dedupe insert failed", insertErr.message);
      }
    }

    return respond(200, {
      success: true,
      sent: true,
      deduped: false,
      meta_key: OUT_OF_AREA_NOTICE_META_KEY,
    });
  } catch (err) {
    console.error("[whatsapp-booking-out-of-area-notify] error:", err);
    return respond(500, {
      success: false,
      error: err instanceof Error ? err.message : "Internal server error",
      sent: false,
    });
  }
});
