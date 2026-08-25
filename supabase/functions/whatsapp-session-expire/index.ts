/**
 * whatsapp-session-expire — Sweep expired WhatsApp booking sessions AND
 * apply existing search-exhausted SSOT for WhatsApp-originated trips.
 *
 * Called by pg_cron every ~1 minute via pg_net.http_post (service-role).
 * Also accepts POST with service-role Bearer for manual invocation / testing.
 *
 * Phase A — booking session expiry:
 *   workflow_state = 'book' AND booking_session_expires_at <= now()
 *   → notify once, reset idle
 *
 * Phase A2 — stuck book hygiene (null expiry permanently bypassed the sweep):
 *   workflow_state = 'book' AND booking_session_expires_at IS NULL
 *   → silent reset to idle (no trip touch). Customer can Book again immediately.
 *
 * Phase B — WhatsApp trip search exhaust (consumes trips.searching_expires_at):
 *   booking_source whatsapp + searching + searching_expires_at <= now + no driver
 *   → expire_trip_when_search_exhausted
 *   → releaseRevolutPreauthForTrip(reason: no_driver_assigned)  [existing SSOT]
 *   → notifyWhatsAppNoDriverForTrip (once) + workflow idle
 *
 * NEVER invents a second search timeout.
 * NEVER cancels unrelated trips or closes independent support conversations.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  readWhatsAppSendCredentials,
  sendWhatsAppTextMessage,
} from "../_shared/whatsappOutbound.ts";
import {
  releaseRevolutPreauthForTrip,
  resolveRevolutOrderIdFromTrip,
} from "../_shared/revolutPreauthReleaseSSOT.ts";
import { notifyWhatsAppNoDriverForTrip } from "../_shared/whatsappNoDriverNotify.ts";

const EXPIRY_MESSAGE =
  "*ONECAB*\nYour booking session has expired.\n\nPlease start a new booking if you still need a ride.";

const SEARCHING_STATES = [
  "pending",
  "searching",
  "offered",
  "broadcasting",
  "offering",
  "searching_new_driver",
];

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
  const results: { phase: string; wa_id_suffix?: string; trip_id?: string; result: string }[] = [];

  // ── Phase A: expired booking sessions (TTL set) ──────────────────────────
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

  for (const row of expired ?? []) {
    const waId = row.wa_id as string;

    const { data: claimed, error: claimErr } = await svcClient
      .from("whatsapp_conversations")
      .update({
        workflow_state: "idle",
        booking_session_started_at: null,
        booking_session_expires_at: null,
        last_outbound_at: nowIso,
        updated_at: nowIso,
      })
      .eq("wa_id", waId)
      .eq("workflow_state", "book")
      .select("wa_id")
      .single();

    if (claimErr || !claimed) {
      results.push({ phase: "session", wa_id_suffix: waId.slice(-6), result: "already_claimed" });
      continue;
    }

    const sendResult = await sendWhatsAppTextMessage(creds, waId, EXPIRY_MESSAGE);
    results.push({
      phase: "session",
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

  // ── Phase A2: stuck book with null expiry (historical hygiene) ───────────
  const { data: stuckBooks, error: stuckErr } = await svcClient
    .from("whatsapp_conversations")
    .select("wa_id")
    .eq("workflow_state", "book")
    .is("booking_session_expires_at", null)
    .limit(50);

  if (stuckErr) {
    console.error("[whatsapp-session-expire] stuck-book fetch failed", stuckErr.message);
  } else {
    for (const row of stuckBooks ?? []) {
      const waId = row.wa_id as string;
      const { data: claimed } = await svcClient
        .from("whatsapp_conversations")
        .update({
          workflow_state: "idle",
          booking_session_started_at: null,
          booking_session_expires_at: null,
          updated_at: nowIso,
        })
        .eq("wa_id", waId)
        .eq("workflow_state", "book")
        .is("booking_session_expires_at", null)
        .select("wa_id")
        .maybeSingle();

      results.push({
        phase: "stuck_book",
        wa_id_suffix: waId.slice(-6),
        result: claimed ? "reset_idle" : "already_claimed",
      });
    }
  }

  // ── Phase B: WhatsApp trips past existing searching_expires_at ───────────
  const { data: exhaustedTrips, error: tripFetchErr } = await svcClient
    .from("trips")
    .select(
      "id, status, driver_id, passenger_id, provider_order_id, payment_provider, payment_status, booking_source, searching_expires_at, no_driver_customer_alert_sent_at",
    )
    .in("booking_source", ["whatsapp_booking", "whatsapp-booking", "whatsapp"])
    .in("status", SEARCHING_STATES)
    .is("driver_id", null)
    .lte("searching_expires_at", nowIso)
    .not("searching_expires_at", "is", null)
    .limit(20);

  if (tripFetchErr) {
    console.error("[whatsapp-session-expire] trip exhaust fetch failed", tripFetchErr.message);
  } else {
    for (const trip of exhaustedTrips ?? []) {
      const tripId = trip.id as string;

      const { data: expiredByServer, error: updateError } = await svcClient.rpc(
        "expire_trip_when_search_exhausted",
        { p_trip_id: tripId },
      );

      if (updateError) {
        results.push({
          phase: "search_exhaust",
          trip_id: tripId,
          result: `expire_rpc_failed:${updateError.message}`,
        });
        continue;
      }

      if (expiredByServer !== true) {
        results.push({
          phase: "search_exhaust",
          trip_id: tripId,
          result: "search_still_active",
        });
        continue;
      }

      const revolutOrderId = resolveRevolutOrderIdFromTrip(trip as Record<string, unknown>);
      if (revolutOrderId) {
        try {
          const revolutRelease = await releaseRevolutPreauthForTrip(svcClient, {
            tripId,
            providerOrderId: revolutOrderId,
            reason: "no_driver_assigned",
            stage: "expire_trip",
            feePence: 0,
          });
          console.log("[whatsapp-session-expire] Revolut hold release", {
            trip_id: tripId,
            provider_order_id: revolutOrderId,
            ...revolutRelease,
          });
        } catch (revolutErr) {
          console.error(
            "[whatsapp-session-expire] Revolut release failed (non-fatal):",
            revolutErr,
          );
        }
      }

      await svcClient
        .from("ride_offers")
        .update({
          status: "revoked",
          revoked_reason: "trip_expired",
          updated_at: nowIso,
        })
        .eq("trip_id", tripId)
        .eq("status", "pending");

      if (trip.passenger_id) {
        await svcClient
          .from("customers")
          .update({ active_trip_id: null })
          .eq("id", trip.passenger_id);
      }

      const waNotify = await notifyWhatsAppNoDriverForTrip(svcClient, tripId);
      results.push({
        phase: "search_exhaust",
        trip_id: tripId,
        result: `expired:${waNotify.status}`,
      });
    }
  }

  return json({ ok: true, swept: results.length, results });
});
