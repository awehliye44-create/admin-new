import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  successResponse,
  errorResponse,
  logAuditEvent,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
} from "../_shared/security.ts";
import { assertPaymentGate, PaymentGateError } from "../_shared/paymentGate.ts";
import { shouldUseUrgentFallbackTrigger } from "../_shared/scheduledRidesPolicy.ts";
import {
  resolveScheduledDispatchConfig,
  shouldConvertScheduledToUrgent,
  buildScheduledUrgentConversionPatch,
  NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES,
} from "../_shared/scheduledDispatchConfig.ts";

const RATE_LIMIT_CONFIG = {
  limit: 30,
  windowMs: 60_000,
  keyPrefix: "schedule-dispatch",
};

/**
 * pg_cron posts the project anon JWT (migration 20260330). assertServiceRole
 * 403'd every tick, so MK-260817 never converted at check-in. Same trust
 * model as scheduled-dispatch: rate-limit only. Vault-token cron is the
 * hardening follow-up (schedule_dispatch_sweep).
 */

async function triggerAutoDispatch(args: {
  supabaseUrl: string;
  supabaseServiceKey: string;
  tripId: string;
  triggerReason: string;
}): Promise<{ ok: boolean; data: unknown }> {
  const { supabaseUrl, supabaseServiceKey, tripId, triggerReason } = args;
  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/auto-dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${supabaseServiceKey}`,
        apikey: supabaseServiceKey,
      },
      body: JSON.stringify({
        trip_id: tripId,
        force_rebroadcast: true,
        trigger_reason: triggerReason,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error("[schedule-dispatch] auto-dispatch failed:", resp.status, data);
      return { ok: false, data };
    }
    return { ok: true, data };
  } catch (err) {
    console.error("[schedule-dispatch] auto-dispatch exception:", err);
    return { ok: false, data: { error: String(err) } };
  }
}

/**
 * schedule-dispatch
 *
 * Cron-triggered (every 1 minute) — NO-PRECONFIRMED path only (Admin "Two paths"):
 *  - No pre-confirmed driver: urgent fallback / check-in → convert to instant + wave
 *  - Confirmed driver: handled by scheduled-dispatch commitment policy — NOT this Edge
 *
 * Customer bookings use scheduled_status=`scheduled` (not `pending`). Convert must
 * flip dispatch_mode to instant and invoke auto-dispatch so Driver shows the nearby card.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) return rateLimitResponse(rateLimitResult);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const now = new Date();
    const nowMs = now.getTime();
    console.log(`[schedule-dispatch] Running at ${now.toISOString()}`);

    const { data: globalCfg } = await supabase
      .from("global_dispatch_settings")
      .select(
        `enable_scheduled_to_urgent_conversion, scheduled_response_window_minutes,
         urgent_dispatch_trigger_minutes_before_pickup, locked_driver_response_minutes,
         max_driver_find_time_minutes, scheduled_urgent_card_label,
         scheduled_rides_enabled`,
      )
      .eq("singleton", true)
      .maybeSingle();

    if (!globalCfg) {
      return errorResponse(
        "No global_dispatch_settings row found. Configure in Admin Panel → Auto-Dispatch Rules.",
        422,
      );
    }

    const schedConfig = resolveScheduledDispatchConfig(globalCfg);
    const scheduledEnabled = Boolean(
      (globalCfg as { scheduled_rides_enabled?: boolean }).scheduled_rides_enabled,
    );
    const maxFindDriverMinutes = schedConfig.maxFindDriverMinutes;

    const { data: pendingTrips, error: tripsErr } = await supabase
      .from("trips")
      .select(
        "id, scheduled_at, scheduled_broadcast_at, scheduled_convert_at, pickup_latitude, pickup_longitude, vehicle_type_id, service_area_id, confirmed_driver_id, driver_id, scheduled_status, status, dispatch_mode, is_scheduled",
      )
      .eq("is_scheduled", true)
      .eq("dispatch_mode", "scheduled")
      .in("scheduled_status", [...NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES])
      .is("confirmed_driver_id", null)
      .is("driver_id", null)
      .not("scheduled_at", "is", null)
      .gt("scheduled_at", new Date(nowMs - 6 * 60 * 60 * 1000).toISOString())
      .not("pickup_latitude", "is", null)
      .not("pickup_longitude", "is", null)
      .order("scheduled_at", { ascending: true })
      .limit(50);

    if (tripsErr) {
      console.error("[schedule-dispatch] Query error:", tripsErr);
      return errorResponse("Failed to query scheduled trips", 500);
    }

    if (!pendingTrips || pendingTrips.length === 0) {
      console.log("[schedule-dispatch] No pending scheduled trips found");
      return successResponse({ processed: 0, convertedToInstant: 0, message: "No trips to dispatch" });
    }

    console.log(`[schedule-dispatch] Found ${pendingTrips.length} candidate trips`);

    const convertTripIds = pendingTrips.map((t: { id: string }) => t.id);
    const { data: convertOffers } = await supabase
      .from("ride_offers")
      .select("trip_id, status, offered_at, created_at")
      .in("trip_id", convertTripIds)
      .order("created_at", { ascending: true });

    const offersByTrip = new Map<string, typeof convertOffers>();
    for (const offer of convertOffers || []) {
      const list = offersByTrip.get(offer.trip_id) ?? [];
      list.push(offer);
      offersByTrip.set(offer.trip_id, list);
    }

    let dispatched = 0;
    let convertedToInstant = 0;
    let skipped = 0;
    let errors = 0;
    const results: Array<{ trip_id: string; action: string; detail?: string }> = [];

    for (const trip of pendingTrips) {
      try {
        const scheduledAt = new Date(trip.scheduled_at);
        const minutesUntilPickup = (scheduledAt.getTime() - nowMs) / 60_000;

        if (!scheduledEnabled) {
          console.log(`[schedule-dispatch] Trip ${trip.id}: scheduled rides disabled globally`);
          skipped++;
          results.push({ trip_id: trip.id, action: "skipped", detail: "scheduled_rides_disabled" });
          continue;
        }

        const hasConfirmedDriver = typeof trip.confirmed_driver_id === "string"
          && trip.confirmed_driver_id.trim().length > 0;

        if (hasConfirmedDriver) {
          console.log(`[schedule-dispatch] Trip ${trip.id}: skipped (confirmed_driver_commitment_path)`);
          skipped++;
          results.push({ trip_id: trip.id, action: "skipped", detail: "confirmed_driver_commitment_path" });
          continue;
        }

        if (
          !shouldUseUrgentFallbackTrigger({
            confirmedDriverId: trip.confirmed_driver_id,
            enableScheduledToUrgentConversion: schedConfig.enableScheduledToUrgentConversion,
          })
        ) {
          console.log(`[schedule-dispatch] Trip ${trip.id}: skipped (urgent_conversion_disabled)`);
          skipped++;
          results.push({ trip_id: trip.id, action: "skipped", detail: "urgent_conversion_disabled" });
          continue;
        }

        const tripOffers = offersByTrip.get(trip.id) ?? [];
        const hasAcceptedOffer = tripOffers.some((o) => o.status === "accepted");
        const firstOffer = tripOffers[0] ?? null;
        const decision = shouldConvertScheduledToUrgent({
          trip: {
            id: trip.id,
            scheduled_at: trip.scheduled_at,
            scheduled_broadcast_at: trip.scheduled_broadcast_at ?? null,
            scheduled_convert_at: trip.scheduled_convert_at ?? null,
            driver_id: trip.driver_id ?? null,
            confirmed_driver_id: trip.confirmed_driver_id ?? null,
          },
          config: schedConfig,
          nowMs,
          firstOfferAnchor: firstOffer,
          hasAcceptedOffer,
        });

        if (!decision.convert) {
          console.log(
            `[schedule-dispatch] Trip ${trip.id}: ${minutesUntilPickup.toFixed(1)}min away, waiting for check-in/urgent`,
          );
          skipped++;
          results.push({
            trip_id: trip.id,
            action: "skipped",
            detail: `${minutesUntilPickup.toFixed(0)}min_away`,
          });
          continue;
        }

        try {
          await assertPaymentGate(supabase, trip.id);
        } catch (e) {
          if (e instanceof PaymentGateError) {
            console.warn(`[schedule-dispatch] Trip ${trip.id}: PAYMENT_GATE_NOT_SATISFIED — ${e.message}`);
            await supabase.from("trips").update({
              scheduled_status: "payment_gate_blocked",
              updated_at: now.toISOString(),
            }).eq("id", trip.id);
            skipped++;
            results.push({ trip_id: trip.id, action: "payment_gate_blocked", detail: e.message });
            continue;
          }
          throw e;
        }

        const searchingExpiresAt = new Date(nowMs + maxFindDriverMinutes * 60_000).toISOString();
        const { data: convertedRows, error: convertErr } = await supabase
          .from("trips")
          .update(buildScheduledUrgentConversionPatch({
            nowIso: now.toISOString(),
            searchingExpiresAtIso: searchingExpiresAt,
          }))
          .eq("id", trip.id)
          .in("scheduled_status", [...NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES])
          .is("driver_id", null)
          .select("id");

        if (convertErr) {
          console.error(`[schedule-dispatch] convert failed for ${trip.id}:`, convertErr);
          errors++;
          results.push({ trip_id: trip.id, action: "error", detail: convertErr.message });
          continue;
        }
        if (!convertedRows || convertedRows.length === 0) {
          skipped++;
          results.push({ trip_id: trip.id, action: "skipped", detail: "convert_matched_0_rows" });
          continue;
        }

        await supabase
          .from("ride_offers")
          .update({ is_urgent_dispatch: true })
          .eq("trip_id", trip.id)
          .in("status", ["pending", "offered", "countered"]);

        const triggerReason = `scheduled_convert_to_instant:${decision.reason}`;
        const dispatchResult = await triggerAutoDispatch({
          supabaseUrl,
          supabaseServiceKey,
          tripId: trip.id,
          triggerReason,
        });

        convertedToInstant++;
        if (dispatchResult.ok) {
          dispatched++;
          results.push({
            trip_id: trip.id,
            action: "converted_to_instant",
            detail: decision.reason,
          });
        } else {
          errors++;
          results.push({
            trip_id: trip.id,
            action: "converted_dispatch_failed",
            detail: decision.reason,
          });
        }

        await logAuditEvent(supabase, "schedule_dispatch_triggered", {
          tripId: trip.id,
          details: {
            minutes_to_pickup: Math.round(minutesUntilPickup),
            trigger_minutes: schedConfig.urgentTriggerMinutesBeforePickup,
            convert_reason: decision.reason,
            had_locked_driver: false,
            service_area_id: trip.service_area_id,
          },
        });
      } catch (tripErr) {
        console.error(`[schedule-dispatch] Error processing trip ${trip.id}:`, tripErr);
        errors++;
        results.push({
          trip_id: trip.id,
          action: "error",
          detail: tripErr instanceof Error ? tripErr.message : "unknown",
        });
      }
    }

    console.log(
      `[schedule-dispatch] Done: converted=${convertedToInstant}, dispatched=${dispatched}, skipped=${skipped}, errors=${errors}`,
    );

    return successResponse({
      processed: pendingTrips.length,
      convertedToInstant,
      dispatched,
      skipped,
      errors,
      results,
    });
  } catch (err) {
    console.error("[schedule-dispatch] Fatal error:", err);
    return errorResponse(err instanceof Error ? err.message : "Unknown error", 500);
  }
});
