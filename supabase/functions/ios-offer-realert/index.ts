import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  handleCORSPreflight,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import { isTripTerminalForDispatch } from "../_shared/tripTerminalDispatch.ts";

/**
 * iOS Offer Re-Alert Edge Function
 *
 * Sends repeated iOS push notifications every 10s after offer creation
 * until offer expires or backend confirms terminal.
 * Does NOT stop on app_received_push, pending storage, or card render evidence.
 *
 * Called fire-and-forget when wired from dispatch. Primary iOS loop lives in
 * ride-offer-reminders (platform-filtered); this function remains for legacy callers.
 */

const TERMINAL_STATUSES = new Set(["accepted", "declined", "expired", "revoked", "cancelled"]);

/** Resend interval in ms while offer is still actionable. */
const IOS_REALERT_INTERVAL_MS = 10_000;

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

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const payload: RealertRequest = await req.json();
    const { offer_id, driver_id, trip_id, title, body: notifBody, data: notifData } = payload;

    if (!offer_id || !driver_id) {
      return errorResponse("VALIDATION", "offer_id and driver_id required", 400);
    }

    const { data: tokenRows } = await supabase
      .from("push_tokens")
      .select("token")
      .eq("driver_id", driver_id)
      .eq("app_type", "driver")
      .eq("platform", "ios");

    if (!tokenRows || tokenRows.length === 0) {
      return successResponse({ skipped: true, reason: "no_ios_token" });
    }

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

    const offerExpiresAt = new Date(offerRow.expires_at).getTime();
    let sent = 0;
    let seq = 0;

    console.log(
      `IOS_OFFER_ALERT_STARTED {"offer_id":"${offer_id}","driver_id":"${driver_id}","expires_at":"${offerRow.expires_at}","interval_ms":${IOS_REALERT_INTERVAL_MS},"source":"ios-offer-realert"}`,
    );

    while (Date.now() + IOS_REALERT_INTERVAL_MS < offerExpiresAt) {
      await sleep(IOS_REALERT_INTERVAL_MS);
      seq += 1;

      console.log(
        `IOS_OFFER_ALERT_REPEAT_SCHEDULED {"offer_id":"${offer_id}","driver_id":"${driver_id}","seq":${seq},"source":"ios-offer-realert"}`,
      );

      console.log(
        `IOS_OFFER_ACTIONABILITY_CHECK_STARTED {"offer_id":"${offer_id}","driver_id":"${driver_id}","trip_id":"${trip_id}"}`,
      );

      const [{ data: liveOffer }, { data: liveTrip }] = await Promise.all([
        supabase.from("ride_offers").select("status, expires_at").eq("id", offer_id).single(),
        supabase
          .from("trips")
          .select("status, scheduled_status, dispatch_status")
          .eq("id", trip_id)
          .maybeSingle(),
      ]);

      if (!liveOffer || TERMINAL_STATUSES.has(liveOffer.status)) {
        console.log(
          `IOS_OFFER_ACTIONABILITY_CHECK_TERMINAL {"offer_id":"${offer_id}","reason":"offer_${liveOffer?.status ?? "not_found"}"}`,
        );
        console.log(
          `IOS_OFFER_ALERT_STOPPED_TERMINAL {"offer_id":"${offer_id}","driver_id":"${driver_id}","reason":"offer_${liveOffer?.status ?? "not_found"}"}`,
        );
        break;
      }

      if (new Date(liveOffer.expires_at).getTime() <= Date.now()) {
        console.log(
          `IOS_OFFER_ACTIONABILITY_CHECK_TERMINAL {"offer_id":"${offer_id}","reason":"offer_expired"}`,
        );
        console.log(
          `IOS_OFFER_ALERT_STOPPED_EXPIRED {"offer_id":"${offer_id}","driver_id":"${driver_id}"}`,
        );
        break;
      }

      if (liveTrip && isTripTerminalForDispatch(liveTrip)) {
        console.log(
          `IOS_OFFER_ACTIONABILITY_CHECK_TERMINAL {"offer_id":"${offer_id}","reason":"trip_${liveTrip.status}"}`,
        );
        console.log(
          `IOS_OFFER_ALERT_STOPPED_TERMINAL {"offer_id":"${offer_id}","driver_id":"${driver_id}","reason":"trip_${liveTrip.status}"}`,
        );
        break;
      }

      console.log(
        `IOS_OFFER_ACTIONABILITY_CHECK_SUCCESS {"offer_id":"${offer_id}","driver_id":"${driver_id}"}`,
      );
      console.log(
        `IOS_OFFER_ALERT_CONTINUES_ACTIONABLE {"offer_id":"${offer_id}","driver_id":"${driver_id}"}`,
      );

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
            targetPlatform: "ios",
            data: {
              ...notifData,
              ios_realert: "true",
              realert_seq: String(seq),
            },
          }),
        });
        sent++;
        console.log(
          `IOS_OFFER_ALERT_REPEAT_SENT {"offer_id":"${offer_id}","driver_id":"${driver_id}","seq":${seq}}`,
        );
        console.log(
          `OFFER_REMINDER_SENT_REASON {"offer_id":"${offer_id}","driver_id":"${driver_id}","seq":${seq},"reason":"ios_realert_continuous_until_terminal"}`,
        );
        console.log('ALERT_SM_REALERT ' + JSON.stringify({
          offer_id, trip_id, driver_id,
          seq: sent, target_sec: seq * (IOS_REALERT_INTERVAL_MS / 1000),
          realert_type: 'apns_background',
        }));
      } catch (pushErr) {
        console.error(`[ios-realert] Push error seq=${seq}:`, pushErr);
      }
    }

    return successResponse({ offer_id, sent });
  } catch (err) {
    console.error("[ios-realert] Error:", err);
    return errorResponse("INTERNAL_ERROR", String(err), 500);
  }
});
