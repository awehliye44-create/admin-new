import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  successResponse,
  errorResponse,
  logAuditEvent,
} from "../_shared/security.ts";

/**
 * schedule-dispatch
 *
 * Cron-triggered (every 1 minute) function that scans for scheduled trips
 * approaching their pickup time and dispatches them.
 *
 * For each eligible trip it:
 *  1. Reads `urgent_dispatch_trigger_minutes_before_pickup` from `dispatch_settings`
 *     (Admin Panel is the single source of truth).
 *  2. If a driver is already locked (`confirmed_driver_id`), sends a direct offer.
 *  3. Otherwise, delegates to `dispatch-drivers` for the full wave-cascade.
 *  4. Updates `scheduled_status` so the trip is not re-processed.
 */

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const now = new Date();
    console.log(`[schedule-dispatch] Running at ${now.toISOString()}`);

    // ══════════════════════════════════════════
    // 1. Find all scheduled trips that are NOT yet dispatching/assigned
    // ══════════════════════════════════════════
    const { data: pendingTrips, error: tripsErr } = await supabase
      .from("trips")
      .select(
        "id, scheduled_at, pickup_latitude, pickup_longitude, vehicle_type_id, service_area_id, confirmed_driver_id, scheduled_status, status"
      )
      .eq("is_scheduled", true)
      .eq("status", "scheduled")
      .in("scheduled_status", ["pending", "driver_assigned"])
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
      .select("urgent_dispatch_trigger_minutes_before_pickup, scheduled_rides_enabled")
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



        // Skip if pickup is still too far away
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

        // Mark as dispatching immediately (prevents re-processing next minute)
        await supabase
          .from("trips")
          .update({
            scheduled_status: "dispatching",
            dispatch_mode: "scheduled",
            updated_at: now.toISOString(),
          })
          .eq("id", trip.id);

        // ── PATH A: Driver already locked (confirmed_driver_id) ──
        if (trip.confirmed_driver_id && trip.scheduled_status === "driver_assigned") {
          console.log(
            `[schedule-dispatch] Trip ${trip.id}: locked driver ${trip.confirmed_driver_id} — sending direct offer via dispatch-drivers`
          );

          const dispatchRes = await fetch(`${supabaseUrl}/functions/v1/dispatch-drivers`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({
              trip_id: trip.id,
              pickup_lat: trip.pickup_latitude,
              pickup_lng: trip.pickup_longitude,
              vehicle_type_id: trip.vehicle_type_id || undefined,
              service_area_id: trip.service_area_id || undefined,
              booking_type: "SCAN_GO",
              assigned_driver_id: trip.confirmed_driver_id,
            }),
          });

          const dispatchData = await dispatchRes.json();
          const success = dispatchData?.data?.dispatched === true;

          if (success) {
            dispatched++;
            results.push({ trip_id: trip.id, action: "dispatched_locked_driver" });
          } else {
            // Locked driver unavailable — fall through to general dispatch
            console.log(
              `[schedule-dispatch] Trip ${trip.id}: locked driver unavailable, falling back to general dispatch`
            );
            const fallbackRes = await fetch(`${supabaseUrl}/functions/v1/dispatch-drivers`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${supabaseServiceKey}`,
              },
              body: JSON.stringify({
                trip_id: trip.id,
                pickup_lat: trip.pickup_latitude,
                pickup_lng: trip.pickup_longitude,
                vehicle_type_id: trip.vehicle_type_id || undefined,
                service_area_id: trip.service_area_id || undefined,
              }),
            });

            const fallbackData = await fallbackRes.json();
            const fallbackSuccess = fallbackData?.data?.dispatched === true;
            dispatched += fallbackSuccess ? 1 : 0;
            errors += fallbackSuccess ? 0 : 1;
            results.push({
              trip_id: trip.id,
              action: fallbackSuccess ? "dispatched_fallback" : "no_drivers",
            });
          }
        }
        // ── PATH B: No pre-assigned driver — full dispatch cascade ──
        else {
          const dispatchRes = await fetch(`${supabaseUrl}/functions/v1/dispatch-drivers`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({
              trip_id: trip.id,
              pickup_lat: trip.pickup_latitude,
              pickup_lng: trip.pickup_longitude,
              vehicle_type_id: trip.vehicle_type_id || undefined,
              service_area_id: trip.service_area_id || undefined,
            }),
          });

          const dispatchData = await dispatchRes.json();
          const success = dispatchData?.data?.dispatched === true;

          dispatched += success ? 1 : 0;
          if (!success) errors++;
          results.push({
            trip_id: trip.id,
            action: success ? "dispatched" : "no_drivers",
            detail: `candidates=${dispatchData?.data?.candidates_scored || 0}`,
          });
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
