import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  successResponse,
  errorResponse,
  logAuditEvent,
} from "../_shared/security.ts";
import { assertServiceRole } from "../_shared/internalAuth.ts";
import { assertPaymentGate, PaymentGateError } from "../_shared/paymentGate.ts";
import { shouldUseUrgentFallbackTrigger } from "../_shared/scheduledRidesPolicy.ts";


/**
 * schedule-dispatch
 *
 * Cron-triggered (every 1 minute) — NO-PRECONFIRMED path only (Admin "Two paths"):
 *  - No pre-confirmed driver: urgent fallback trigger + response window → wave dispatch
 *  - Confirmed driver: handled by scheduled-dispatch commitment policy — NOT this Edge
 *
 * For each eligible unconfirmed trip it:
 *  1. Reads `urgent_dispatch_trigger_minutes_before_pickup` from global settings
 *     — FALLBACK ONLY when there is no pre-confirmed driver.
 *  2. Invokes `dispatch_trip_offers` RPC for the full wave-cascade.
 *  3. Updates `scheduled_status` so the trip is not re-processed.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const gate = assertServiceRole(req);
  if (gate) return gate;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const now = new Date();
    console.log(`[schedule-dispatch] Running at ${now.toISOString()}`);

    // ══════════════════════════════════════════
    // 1. Find scheduled trips with NO pre-confirmed driver
    // ══════════════════════════════════════════
    const { data: pendingTrips, error: tripsErr } = await supabase
      .from("trips")
      .select(
        "id, scheduled_at, pickup_latitude, pickup_longitude, vehicle_type_id, service_area_id, confirmed_driver_id, scheduled_status, status"
      )
      .eq("is_scheduled", true)
      .eq("status", "scheduled")
      .in("scheduled_status", ["pending", "driver_assigned"])
      .is("confirmed_driver_id", null)
      .is("driver_id", null)
      .not("scheduled_at", "is", null)
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
      return successResponse({ processed: 0, message: "No trips to dispatch" });
    }

    console.log(`[schedule-dispatch] Found ${pendingTrips.length} candidate trips`);

    // ══════════════════════════════════════════
    // 2. Load GLOBAL dispatch settings (singleton — applies to all service areas)
    // ══════════════════════════════════════════
    const { data: globalCfg } = await supabase
      .from("global_dispatch_settings")
      .select(
        "urgent_dispatch_trigger_minutes_before_pickup, scheduled_rides_enabled, enable_scheduled_to_urgent_conversion",
      )
      .eq("singleton", true)
      .maybeSingle();

    if (!globalCfg) {
      return errorResponse(
        "No global_dispatch_settings row found. Configure in Admin Panel → Auto-Dispatch Rules.",
        422
      );
    }

    const triggerMinutes = Number(globalCfg.urgent_dispatch_trigger_minutes_before_pickup);
    const scheduledEnabled = Boolean(globalCfg.scheduled_rides_enabled);
    const urgentConversionEnabled = globalCfg.enable_scheduled_to_urgent_conversion !== false;

    // ══════════════════════════════════════════
    // 3. Process each trip
    // ══════════════════════════════════════════
    let dispatched = 0;
    let skipped = 0;
    let errors = 0;
    const results: Array<{ trip_id: string; action: string; detail?: string }> = [];

    for (const trip of pendingTrips) {
      try {
        const scheduledAt = new Date(trip.scheduled_at);
        const minutesUntilPickup = (scheduledAt.getTime() - now.getTime()) / 60000;

        // Skip if scheduled rides are globally disabled
        if (!scheduledEnabled) {
          console.log(`[schedule-dispatch] Trip ${trip.id}: scheduled rides disabled globally`);
          skipped++;
          results.push({ trip_id: trip.id, action: "skipped", detail: "scheduled_rides_disabled" });
          continue;
        }

        const hasConfirmedDriver = typeof trip.confirmed_driver_id === "string"
          && trip.confirmed_driver_id.trim().length > 0;

        // Admin Two paths: confirmed drivers never use this fixed urgent Edge.
        if (hasConfirmedDriver) {
          console.log(`[schedule-dispatch] Trip ${trip.id}: skipped (confirmed_driver_commitment_path)`);
          skipped++;
          results.push({ trip_id: trip.id, action: "skipped", detail: "confirmed_driver_commitment_path" });
          continue;
        }

        // Unconfirmed trips only convert to urgent when conversion is enabled.
        if (
          !shouldUseUrgentFallbackTrigger({
            confirmedDriverId: trip.confirmed_driver_id,
            enableScheduledToUrgentConversion: urgentConversionEnabled,
          })
        ) {
          console.log(`[schedule-dispatch] Trip ${trip.id}: skipped (urgent_conversion_disabled)`);
          skipped++;
          results.push({ trip_id: trip.id, action: "skipped", detail: "urgent_conversion_disabled" });
          continue;
        }

        // No-preconfirmed path: fixed urgent fallback (pickup-minus Admin minutes).
        if (minutesUntilPickup > triggerMinutes) {
          console.log(
            `[schedule-dispatch] Trip ${trip.id}: ${minutesUntilPickup.toFixed(1)}min away, trigger at ${triggerMinutes}min — skipping`
          );
          skipped++;
          results.push({ trip_id: trip.id, action: "skipped", detail: `${minutesUntilPickup.toFixed(0)}min_away` });
          continue;
        }


        // Skip trips that are already past their scheduled time by more than 30 min (stale)
        if (minutesUntilPickup < -30) {
          console.log(`[schedule-dispatch] Trip ${trip.id}: ${Math.abs(minutesUntilPickup).toFixed(0)}min overdue — marking stale`);
          await supabase
            .from("trips")
            .update({
              scheduled_status: "stale",
              updated_at: now.toISOString(),
            })
            .eq("id", trip.id);
          skipped++;
          results.push({ trip_id: trip.id, action: "stale", detail: "overdue_30min" });
          continue;
        }

        console.log(
          `[schedule-dispatch] Trip ${trip.id}: ${minutesUntilPickup.toFixed(1)}min to pickup — dispatching`
        );

        // P0 PAYMENT GATE: independently re-verify a digital trip's payment
        // authorisation before touching dispatch state. Non-digital trips no-op.
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


        // Mark as dispatching immediately (prevents re-processing next minute)
        await supabase
          .from("trips")
          .update({
            scheduled_status: "dispatching",
            dispatch_mode: "scheduled",
            updated_at: now.toISOString(),
          })
          .eq("id", trip.id);

        // Dispatch via the SQL RPC (single production dispatcher → ride_offers)
        const { data: rpcData, error: rpcErr } = await supabase.rpc(
          "dispatch_trip_offers",
          { p_trip_id: trip.id, p_trigger_reason: "scheduled_lead_time" },
        );

        if (rpcErr) {
          console.error(`[schedule-dispatch] dispatch_trip_offers failed for ${trip.id}:`, rpcErr);
          errors++;
          results.push({ trip_id: trip.id, action: "error", detail: rpcErr.message });
        } else {
          const r: any = rpcData ?? {};
          const offersCreated = Number(r.offers_created ?? 0);
          const status = String(r.status ?? 'unknown');

          if (offersCreated > 0 || status === 'dispatched' || status === 'dispatched_locked_driver') {
            dispatched++;
            results.push({
              trip_id: trip.id,
              action: trip.confirmed_driver_id ? "dispatched_locked_driver" : "dispatched",
              detail: `status=${status} offers=${offersCreated} round=${r.round ?? '?'}`,
            });
          } else {
            errors++;
            results.push({
              trip_id: trip.id,
              action: status === 'no_drivers' ? 'no_drivers' : status,
              detail: r.reason ?? null,
            });
          }
        }


        // Audit log
        await logAuditEvent(supabase, "schedule_dispatch_triggered", {
          tripId: trip.id,
          details: {
            minutes_to_pickup: Math.round(minutesUntilPickup),
            trigger_minutes: triggerMinutes,
            had_locked_driver: !!trip.confirmed_driver_id,
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
      `[schedule-dispatch] Done: dispatched=${dispatched}, skipped=${skipped}, errors=${errors}`
    );

    return successResponse({
      processed: pendingTrips.length,
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
