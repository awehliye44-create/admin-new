/**
 * #100A — Server-side waiting SSOT advance (cron).
 *
 * Recovery mechanism (not a second waiting clock): reuses syncWaitingGeofenceClock
 * + absolute charge-from-counted formulas identical to client ticks.
 * Evaluates pickup and intermediate-stop waiting without depending on the
 * Driver app remaining open. Uses trusted GPS only (no body coords).
 * Stamps pickup_waiting_last_tick_at via syncWaitingGeofenceClock.
 * Applies chargeable waiting when free wait has expired (same formula as tick).
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import { isTripAtPickupStatus, resolveDriverArrivedAtIso } from "../_shared/pickupWaiting.ts";
import {
  loadAdminWaitingConfig,
  resolveFrozenOrLiveWaitingConfig,
} from "../_shared/waitingAdminConfig.ts";
import {
  computePickupChargeFromCountedSeconds,
  computeStopChargeFromCountedSeconds,
  resolveEffectiveWaitingRadiusMeters,
  syncWaitingGeofenceClock,
} from "../_shared/waitingSegmentClock.ts";
import { eligibleFromMsForPickupTrip } from "../_shared/scheduledPickupWaitingFairnessSSOT.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const auth = await assertCronOrServiceRoleAuth(req, body);
  if (!auth.ok) return auth.response;

  const limit = Math.min(40, Math.max(1, Number(body.limit ?? 20)));
  const dryRun = body.dry_run === true;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const results: Array<Record<string, unknown>> = [];
  let scannedPickup = 0;
  let scannedStop = 0;

  // ── Pickup waiting recovery ──────────────────────────────────────────
  const { data: pickupRows, error: pickupErr } = await supabase
    .from("trips")
    .select(
      "id, trip_code, driver_id, confirmed_driver_id, status, arrived_at, pickup_arrived_at, pickup_waiting_started_at, service_area_id, vehicle_type_id, pickup_latitude, pickup_longitude, pickup_waiting_admin_config, pickup_waiting_finalized_at, pickup_waiting_counted_seconds, pickup_waiting_charge_pence, pickup_waiting_intervals_charged, pickup_paid_waiting_started_at, grace_period_expired_at, no_show_charge_pence, late_cancel_fee_pence, scheduled_at, is_scheduled, waiting_geofence_checked_at, pickup_waiting_last_tick_at",
    )
    .is("pickup_waiting_finalized_at", null)
    .not("pickup_waiting_started_at", "is", null)
    .in("status", [
      "arrived",
      "arrived_pickup",
      "arrived_at_pickup",
      "at_pickup",
      "pickup_waiting",
      "waiting",
      "driver_arrived",
      "waiting_at_pickup",
    ])
    .order("waiting_geofence_checked_at", { ascending: true, nullsFirst: true })
    .limit(limit);

  if (pickupErr) {
    return new Response(JSON.stringify({ ok: false, error: pickupErr.message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  scannedPickup = (pickupRows ?? []).length;

  for (const trip of pickupRows ?? []) {
    if (!isTripAtPickupStatus(trip.status as string)) continue;
    if (Number(trip.no_show_charge_pence ?? 0) > 0) continue;
    if (Number(trip.late_cancel_fee_pence ?? 0) > 0) continue;

    const tripId = String(trip.id);
    const driverId = String(trip.driver_id ?? trip.confirmed_driver_id ?? "");
    if (!driverId) {
      results.push({ trip_id: tripId, scope: "pickup", status: "SKIPPED", reason: "missing_driver" });
      continue;
    }

    if (dryRun) {
      results.push({
        trip_id: tripId,
        trip_code: trip.trip_code,
        scope: "pickup",
        status: "DRY_RUN",
        last_tick_at: trip.pickup_waiting_last_tick_at,
        checked_at: trip.waiting_geofence_checked_at,
        counted: trip.pickup_waiting_counted_seconds,
      });
      continue;
    }

    try {
      const nowIso = new Date().toISOString();
      const nowMs = Date.parse(nowIso);
      const liveConfig = await loadAdminWaitingConfig(
        supabase,
        trip.service_area_id as string | null,
        trip.vehicle_type_id as string | null,
      );
      const config = resolveFrozenOrLiveWaitingConfig(
        trip.pickup_waiting_admin_config,
        liveConfig,
      );
      if (!trip.pickup_waiting_admin_config) {
        await supabase
          .from("trips")
          .update({ pickup_waiting_admin_config: config })
          .eq("id", tripId);
      }

      const pickupArrivedAt = await resolveDriverArrivedAtIso(supabase, tripId, trip);
      const pickupWaitingStartedAt =
        typeof trip.pickup_waiting_started_at === "string"
          ? trip.pickup_waiting_started_at
          : pickupArrivedAt;
      if (!pickupWaitingStartedAt) {
        results.push({ trip_id: tripId, scope: "pickup", status: "SKIPPED", reason: "no_waiting_start" });
        continue;
      }

      const eligibleFromMs = eligibleFromMsForPickupTrip(trip as {
        arrived_at?: string | null;
        pickup_arrived_at?: string | null;
        scheduled_at?: string | null;
        is_scheduled?: boolean | null;
      });

      const clock = await syncWaitingGeofenceClock(supabase, {
        tripId,
        driverId,
        locationType: "pickup",
        target: {
          lat: trip.pickup_latitude as number,
          lng: trip.pickup_longitude as number,
          radiusMeters: resolveEffectiveWaitingRadiusMeters(
            config.pickup_radius_meters,
            config.pickup_radius_enabled,
          ),
          radiusEnabled: config.pickup_radius_enabled,
        },
        bodyLat: null,
        bodyLng: null,
        nowIso,
        eligibleFromMs,
      });

      const countedSeconds = clock.countedSeconds;
      const gracePeriodSeconds = config.free_pickup_waiting_seconds;
      const paidWaitingEnabled = config.pickup_paid_waiting_enabled === true;
      const graceExpired = countedSeconds >= gracePeriodSeconds;
      let chargePence = Number(trip.pickup_waiting_charge_pence ?? 0);
      let intervals = Number(trip.pickup_waiting_intervals_charged ?? 0);

      if (
        graceExpired &&
        paidWaitingEnabled &&
        clock.evidenceComplete &&
        config.waiting_charge_interval_seconds > 0 &&
        config.pickup_paid_waiting_rate_pence_per_minute > 0
      ) {
        const charged = computePickupChargeFromCountedSeconds({
          countedSeconds,
          freeWaitSeconds: gracePeriodSeconds,
          ratePencePerMinute: config.pickup_paid_waiting_rate_pence_per_minute,
          intervalSeconds: config.waiting_charge_interval_seconds,
          maxMinutes: config.pickup_waiting_max_minutes,
        });
        if (
          charged.intervals_charged !== intervals ||
          charged.charge_pence !== chargePence
        ) {
          const updateData: Record<string, unknown> = {
            pickup_waiting_charge_pence: charged.charge_pence,
            pickup_waiting_intervals_charged: charged.intervals_charged,
            pickup_waiting_chargeable_seconds: charged.paid_seconds_capped,
            pickup_waiting_counted_seconds: countedSeconds,
            pickup_waiting_last_tick_at: nowIso,
            updated_at: nowIso,
          };
          if (!trip.grace_period_expired_at) {
            updateData.grace_period_expired_at = nowIso;
          }
          if (!trip.pickup_paid_waiting_started_at && charged.charge_pence > 0) {
            updateData.pickup_paid_waiting_started_at = nowIso;
          }
          await supabase.from("trips").update(updateData).eq("id", tripId);
          chargePence = charged.charge_pence;
          intervals = charged.intervals_charged;
        }
      }

      results.push({
        trip_id: tripId,
        trip_code: trip.trip_code,
        scope: "pickup",
        status: "ADVANCED",
        counted_seconds: countedSeconds,
        geofence: clock.status,
        grace_expired: graceExpired,
        charge_pence: chargePence,
        intervals,
        evaluated_at: nowIso,
        age_ms: Number.isFinite(nowMs) ? 0 : null,
      });
    } catch (e) {
      results.push({
        trip_id: tripId,
        scope: "pickup",
        status: "FAILED",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ── Intermediate stop waiting recovery (same segment SSOT as tick-waiting-charge) ─
  const stopBudget = Math.max(1, limit - scannedPickup + Math.min(limit, 10));
  const { data: stopRows, error: stopErr } = await supabase
    .from("trip_stops")
    .select(
      "id, trip_id, type, stop_index, lat, lng, arrived_at, waiting_charge_active, waiting_started_at, waiting_total_amount_pence, waiting_total_seconds, last_waiting_charge_update_at",
    )
    .eq("waiting_charge_active", true)
    .not("waiting_started_at", "is", null)
    .not("arrived_at", "is", null)
    .eq("type", "stop")
    .order("last_waiting_charge_update_at", { ascending: true, nullsFirst: true })
    .limit(stopBudget);

  if (stopErr) {
    results.push({ scope: "stop", status: "QUERY_FAILED", reason: stopErr.message });
  } else {
    scannedStop = (stopRows ?? []).length;
    for (const stop of stopRows ?? []) {
      const stopId = String(stop.id);
      const tripId = String(stop.trip_id);
      if (stop.lat == null || stop.lng == null) {
        results.push({
          trip_id: tripId,
          stop_id: stopId,
          scope: "stop",
          status: "SKIPPED",
          reason: "missing_coords",
        });
        continue;
      }

      const { data: trip } = await supabase
        .from("trips")
        .select(
          "id, trip_code, driver_id, confirmed_driver_id, status, service_area_id, stop_waiting_paid_started_at, stop_waiting_status, stop_waiting_counted_seconds, stop_waiting_charge_pence",
        )
        .eq("id", tripId)
        .maybeSingle();

      if (!trip) {
        results.push({
          trip_id: tripId,
          stop_id: stopId,
          scope: "stop",
          status: "SKIPPED",
          reason: "trip_missing",
        });
        continue;
      }

      const status = String(trip.status ?? "").toLowerCase();
      if (
        status !== "in_progress" &&
        status !== "started" &&
        status !== "en_route_stop" &&
        status !== "at_stop" &&
        status !== "arrived_at_stop"
      ) {
        results.push({
          trip_id: tripId,
          stop_id: stopId,
          scope: "stop",
          status: "SKIPPED",
          reason: `status_${status || "unknown"}`,
        });
        continue;
      }

      const driverId = String(trip.driver_id ?? trip.confirmed_driver_id ?? "");
      if (!driverId) {
        results.push({
          trip_id: tripId,
          stop_id: stopId,
          scope: "stop",
          status: "SKIPPED",
          reason: "missing_driver",
        });
        continue;
      }

      if (dryRun) {
        results.push({
          trip_id: tripId,
          trip_code: trip.trip_code,
          stop_id: stopId,
          scope: "stop",
          status: "DRY_RUN",
          counted: trip.stop_waiting_counted_seconds,
          charge_pence: stop.waiting_total_amount_pence,
        });
        continue;
      }

      try {
        const nowIso = new Date().toISOString();
        const config = await loadAdminWaitingConfig(
          supabase,
          trip.service_area_id as string | null,
        );
        if (config.enable_stop_waiting_charge === false) {
          results.push({
            trip_id: tripId,
            stop_id: stopId,
            scope: "stop",
            status: "SKIPPED",
            reason: "stop_waiting_disabled",
          });
          continue;
        }

        const clock = await syncWaitingGeofenceClock(supabase, {
          tripId,
          driverId,
          locationType: "stop",
          stopId,
          stopIndex: stop.stop_index ?? null,
          target: {
            lat: stop.lat as number,
            lng: stop.lng as number,
            radiusMeters: resolveEffectiveWaitingRadiusMeters(
              config.stop_radius_meters,
              config.stop_radius_enabled,
            ),
            radiusEnabled: config.stop_radius_enabled,
          },
          bodyLat: null,
          bodyLng: null,
          nowIso,
        });

        if (!clock.evidenceComplete) {
          results.push({
            trip_id: tripId,
            stop_id: stopId,
            scope: "stop",
            status: "ADVANCED",
            note: "evidence_incomplete_charge_unchanged",
            counted_seconds: clock.countedSeconds,
            geofence: clock.status,
          });
          continue;
        }

        const countedSeconds = clock.countedSeconds;
        const gracePeriod = config.free_stop_waiting_seconds;
        const ratePPM = config.stop_waiting_rate_pence_per_minute;
        const maxMinutes = config.stop_waiting_max_minutes;
        const previousPence = Number(stop.waiting_total_amount_pence ?? 0);

        if (countedSeconds >= gracePeriod && !trip.stop_waiting_paid_started_at) {
          await supabase
            .from("trips")
            .update({
              stop_waiting_paid_started_at: nowIso,
              stop_waiting_status: "paid_waiting",
            })
            .eq("id", tripId);
        }

        const charged = computeStopChargeFromCountedSeconds({
          countedSeconds,
          freeWaitSeconds: gracePeriod,
          ratePencePerMinute: ratePPM,
          maxMinutes,
        });
        const totalPence = charged.charge_pence;
        const chargeableSeconds = charged.paid_seconds;
        const capped =
          maxMinutes != null &&
          maxMinutes > 0 &&
          chargeableSeconds >= Math.round(maxMinutes) * 60;

        if (totalPence !== previousPence || capped) {
          await supabase
            .from("trip_stops")
            .update({
              waiting_charge_active: capped ? false : true,
              waiting_total_amount_pence: totalPence,
              waiting_total_seconds: countedSeconds,
              waiting_stopped_at: capped ? nowIso : null,
              last_waiting_charge_update_at: nowIso,
            })
            .eq("id", stopId);

          const { data: allStops } = await supabase
            .from("trip_stops")
            .select("waiting_total_amount_pence")
            .eq("trip_id", tripId);
          const tripTotal = (allStops ?? []).reduce(
            (sum: number, s: { waiting_total_amount_pence?: number | null }) =>
              sum + (s.waiting_total_amount_pence || 0),
            0,
          );
          await supabase
            .from("trips")
            .update({
              total_waiting_charge_pence: tripTotal,
              stop_waiting_charge_pence: tripTotal,
              stop_charge_total_pence: tripTotal,
              stop_waiting_charge_amount: totalPence,
              stop_waiting_counted_seconds: countedSeconds,
              updated_at: nowIso,
            })
            .eq("id", tripId);
        }

        results.push({
          trip_id: tripId,
          trip_code: trip.trip_code,
          stop_id: stopId,
          scope: "stop",
          status: "ADVANCED",
          counted_seconds: countedSeconds,
          geofence: clock.status,
          charge_pence: totalPence,
          capped,
          evaluated_at: nowIso,
        });
      } catch (e) {
        results.push({
          trip_id: tripId,
          stop_id: stopId,
          scope: "stop",
          status: "FAILED",
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      dry_run: dryRun,
      scanned_pickup: scannedPickup,
      scanned_stop: scannedStop,
      scanned: scannedPickup + scannedStop,
      results,
    }),
    { status: 200, headers: { ...cors, "Content-Type": "application/json" } },
  );
});
