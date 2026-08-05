import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  handleCORSPreflight,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";

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
          // Clients must match offerId before tearing down a newer active offer.
          invalidates_offer_id: row.offer_id,
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
 * Cron (~10s): process_ride_offer_ack_timeouts expires pending offers only after
 * their authoritative expires_at (Admin wave SSOT). This Edge function is the
 * sole redispatch owner → auto-dispatch force_rebroadcast (idempotent).
 *
 * Cron frequency is NOT the offer duration.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  // Accept CRON_SECRET / service-role (pg_cron uses cron_edge_auth_token).
  const auth = await assertCronOrServiceRoleAuth(req);
  if (!auth.ok) return auth.response;

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

      // Do not notify if this driver already has a newer pending offer (replacement).
      const { count: newerPending } = await supabase
        .from("ride_offers")
        .select("id", { count: "exact", head: true })
        .eq("driver_id", row.driver_id)
        .eq("status", "pending")
        .neq("id", row.offer_id);

      if ((newerPending ?? 0) > 0) {
        console.log(
          `[ack-timeout-sweep] skip notify — driver has newer pending offer driver=${row.driver_id} expired_offer=${row.offer_id}`,
        );
        continue;
      }

      await sendRideNoLongerAvailable(supabaseUrl, supabaseKey, row);
    }

    const uniqueTripIds = [...new Set(rows.map((r) => r.trip_id).filter(Boolean))];
    const rebroadcastResults: {
      trip_id: string;
      success: boolean;
      error?: string;
      dispatch_round?: number | null;
    }[] = [];

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

        const { data: tripRow } = await supabase
          .from("trips")
          .select("id, service_area_id, current_broadcast_round, max_broadcast_rounds, status, dispatch_status")
          .eq("id", tripId)
          .maybeSingle();

        console.log("[ack-timeout-sweep] redispatch_attempt", {
          trip_id: tripId,
          service_area_id: tripRow?.service_area_id ?? null,
          current_broadcast_round: tripRow?.current_broadcast_round ?? null,
          max_broadcast_rounds: tripRow?.max_broadcast_rounds ?? null,
          status: tripRow?.status ?? null,
          source: "ack_timeout_reassign",
        });

        const { data: dispatchResult, error: dispatchError } = await supabase.functions.invoke(
          "auto-dispatch",
          {
            body: {
              trip_id: tripId,
              force_rebroadcast: true,
              source: "ack_timeout_reassign",
            },
          },
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
            p_detail: {
              force_rebroadcast: true,
              reassigned_at: iso,
              source: "ack_timeout_reassign",
              prior_round: tripRow?.current_broadcast_round ?? null,
              result: dispatchResult ?? null,
            },
          });
          if (bdlErr) {
            console.warn("[ack-timeout-sweep] record_booking_delivery failed:", bdlErr);
          }
          rebroadcastResults.push({
            trip_id: tripId,
            success: true,
            dispatch_round: tripRow?.current_broadcast_round ?? null,
          });
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
