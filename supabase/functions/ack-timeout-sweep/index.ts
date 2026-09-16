import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  handleCORSPreflight,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";

const RATE_LIMIT_CONFIG = { limit: 120, windowMs: 60000, keyPrefix: "ack-timeout-sweep" };

type CancelledRow = { offer_id: string; trip_id: string; driver_id: string };

async function sendRideNoLongerAvailable(
  supabaseUrl: string,
  serviceKey: string,
  row: CancelledRow,
) {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/send-driver-notification`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        driverId: row.driver_id,
        type: "TRIP_UPDATE",
        title: "Ride no longer available",
        body: "This offer timed out waiting for confirmation. You can receive the next one.",
        data: {
          type: "ride_no_longer_available",
          notificationType: "ride_no_longer_available",
          stopReason: "ride_no_longer_available",
          stop_reason: "ride_no_longer_available",
          booking_id: row.trip_id,
          trip_id: row.trip_id,
          tripId: row.trip_id,
          offer_id: row.offer_id,
          offerId: row.offer_id,
        },
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn(`[ack-timeout-sweep] notify driver=${row.driver_id} status=${res.status} ${t}`);
    }
  } catch (e) {
    console.warn(`[ack-timeout-sweep] notify exception driver=${row.driver_id}:`, e);
  }
}

/**
 * Runs every ~5s via pg_cron: expire pending offers missing booking_received ACK (10s
 * from first dispatch bookkeeping), notify affected drivers, then rebroadcast trips
 * notify affected drivers (ride_no_longer_available), then rebroadcast trips with
 * zero pending offers.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: cancelled, error } = await supabase.rpc("process_ride_offer_ack_timeouts");

    if (error) {
      console.error("[ack-timeout-sweep] RPC error:", error);
      return errorResponse("DB_ERROR", error.message ?? "RPC failed", 500);
    }

    const rows: CancelledRow[] = (cancelled ?? []) as CancelledRow[];
    console.log("[ack-timeout-sweep] ACK timeouts processed:", rows.length);

    for (const row of rows) {
      const iso = new Date().toISOString();
      console.log(
        `[booking_delivery] ack_timeout booking_id=${row.trip_id} offer_id=${row.offer_id} driver_id=${row.driver_id} timeout_at=${iso} layer=edge_sweep`,
      );
      console.log(
        `[delivery] ack_timeout_sweep edge_row booking_id=${row.trip_id} offer_id=${row.offer_id} driver_id=${row.driver_id} timeout_at=${iso} reassigned_at=${iso}`,
      );
      await sendRideNoLongerAvailable(supabaseUrl, supabaseKey, row);
    }

    const uniqueTripIds = [...new Set(rows.map((r) => r.trip_id).filter(Boolean))];
    const rebroadcastResults: { trip_id: string; success: boolean; error?: string }[] = [];

    for (const tripId of uniqueTripIds) {
      try {
        const { count: pendingLeft, error: pendingErr } = await supabase
          .from("ride_offers")
          .select("id", { count: "exact", head: true })
          .eq("trip_id", tripId)
          .eq("status", "pending");

        if (pendingErr) {
          console.error("[ack-timeout-sweep] pending-count failed", tripId, pendingErr);
          rebroadcastResults.push({
            trip_id: tripId,
            success: false,
            error: pendingErr.message,
          });
          continue;
        }

        if ((pendingLeft ?? 0) > 0) {
          console.log("[ack-timeout-sweep] skip rebroadcast — still has pending offers", tripId, pendingLeft);
          rebroadcastResults.push({ trip_id: tripId, success: true, error: "skipped_still_pending" });
          continue;
        }

        const { data: dispatchResult, error: dispatchError } = await supabase.functions.invoke(
          "auto-dispatch",
          { body: { trip_id: tripId, force_rebroadcast: true } },
        );

        if (dispatchError) {
          console.error("[ack-timeout-sweep] auto-dispatch failed", tripId, dispatchError);
          rebroadcastResults.push({ trip_id: tripId, success: false, error: dispatchError.message });
        } else {
          const iso = new Date().toISOString();
          console.log(
            `[booking_delivery] reassigned booking_id=${tripId} layer=edge_auto_dispatch force_rebroadcast=true reassigned_at=${iso}`,
          );
          console.log("[ack-timeout-sweep] rebroadcast ok", tripId, dispatchResult);
          const { error: bdlErr } = await supabase.rpc("record_booking_delivery", {
            p_booking_id: tripId,
            p_phase: "reassigned_auto_dispatch",
            p_detail: { force_rebroadcast: true, reassigned_at: iso },
          });
          if (bdlErr) {
            console.warn("[ack-timeout-sweep] record_booking_delivery failed:", bdlErr);
          }
          rebroadcastResults.push({ trip_id: tripId, success: true });
        }
      } catch (err) {
        console.error("[ack-timeout-sweep] auto-dispatch exception", tripId, err);
        rebroadcastResults.push({ trip_id: tripId, success: false, error: String(err) });
      }
    }

    return successResponse({
      success: true,
      ack_timeouts: rows.length,
      rebroadcast: rebroadcastResults,
    });
  } catch (e) {
    console.error("[ack-timeout-sweep]", e);
    return errorResponse("INTERNAL_ERROR", String(e), 500);
  }
});
