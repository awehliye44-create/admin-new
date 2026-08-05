import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  handleCORSPreflight,
  requireServiceRole,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";

/**
 * iOS Offer Re-Alert Edge Function
 *
 * Sends repeated iOS push notifications at 10s, 20s, 30s after offer creation
 * to wake a locked/backgrounded device, strictly within the 40-second offer
 * lifetime.  Before every resend the offer status is checked live — if the
 * offer has reached any terminal state the loop exits immediately.
 *
 * Called fire-and-forget by auto-dispatch after the initial push.
 * Only targets iOS tokens.
 */

const TERMINAL_STATUSES = new Set(["accepted", "declined", "expired", "revoked", "cancelled"]);

/** Resend checkpoints in seconds after offer creation. */
const RESEND_AT_SECONDS = [10, 20, 30];

interface RealertRequest {
  offer_id: string;
  driver_id: string;
  trip_id: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  // Internal-only: only auto-dispatch (service-role) should call this.
  const _svc = requireServiceRole(req);
  if (_svc) return _svc;



  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const payload: RealertRequest = await req.json();
    const { offer_id, driver_id, trip_id, title, body: notifBody, data: notifData } = payload;

    if (!offer_id || !driver_id) {
      return errorResponse("VALIDATION", "offer_id and driver_id required", 400);
    }

    // ── Resolve iOS token for this driver (active only, committed driver_id) ──
    const { data: tokenRows } = await supabase
      .from("push_tokens")
      .select("token")
      .eq("driver_id", driver_id)
      .eq("app_type", "driver")
      .eq("platform", "ios")
      .eq("is_active", true);

    if (!tokenRows || tokenRows.length === 0) {
      // Not an iOS device — nothing to do
      return successResponse({ skipped: true, reason: "no_ios_token" });
    }

    // Fetch the offer's created_at to anchor the timing window
    const { data: offerRow, error: offerErr } = await supabase
      .from("ride_offers")
      .select("status, created_at, expires_at")
      .eq("id", offer_id)
      .single();

    if (offerErr || !offerRow) {
      return successResponse({ skipped: true, reason: "offer_not_found" });
    }

    if (TERMINAL_STATUSES.has(offerRow.status)) {
      return successResponse({ skipped: true, reason: "already_terminal" });
    }

    const offerCreatedAt = new Date(offerRow.created_at).getTime();
    const offerExpiresAt = new Date(offerRow.expires_at).getTime();
    let sent = 0;

    for (const targetSec of RESEND_AT_SECONDS) {
      const targetTime = offerCreatedAt + targetSec * 1000;
      const now = Date.now();

      // If target is already past or beyond expiry, skip
      if (targetTime <= now || targetTime >= offerExpiresAt) continue;

      // Sleep until target time
      const delayMs = targetTime - now;
      if (delayMs > 0) await sleep(delayMs);

      // Live-check offer status before sending
      const { data: liveOffer } = await supabase
        .from("ride_offers")
        .select("status")
        .eq("id", offer_id)
        .single();

      if (!liveOffer || TERMINAL_STATUSES.has(liveOffer.status)) {
        console.log(`[ios-realert] Offer ${offer_id} terminal (${liveOffer?.status}) at ${targetSec}s — stopping`);
        break;
      }

      // Send the re-alert push via send-driver-notification
      try {
        await fetch(`${supabaseUrl}/functions/v1/send-driver-notification`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            driverId: driver_id,
            type: "RIDE_OFFER",
            title,
            body: notifBody,
            data: {
              ...notifData,
              ios_realert: "true",
              realert_seq: String(targetSec),
            },
          }),
        });
        sent++;
        console.log(`[ios-realert] Sent re-alert #${sent} at ${targetSec}s for offer ${offer_id}`);
      } catch (pushErr) {
        console.error(`[ios-realert] Push error at ${targetSec}s:`, pushErr);
      }
    }

    return successResponse({ offer_id, sent });
  } catch (err) {
    console.error("[ios-realert] Error:", err);
    return errorResponse("INTERNAL_ERROR", String(err), 500);
  }
});
