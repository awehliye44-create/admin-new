/**
 * schedule-dispatch NO-PRECONFIRMED urgent conversion sweep.
 *
 * A terminal trip (cancelled / completed / expired / no_show …) must never be
 * selected or converted, even if scheduled_status was left non-terminal
 * (MK-260916-030: cancelled with a late-cancel fee, then converted to
 * `searching` and accepted by a driver).
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { shouldUseUrgentFallbackTrigger } from "./scheduledRidesPolicy.ts";
import {
  buildScheduledUrgentConversionPatch,
  NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES,
  resolveScheduledDispatchConfig,
  shouldConvertScheduledToUrgent,
} from "./scheduledDispatchConfig.ts";
import {
  blockedTerminalTripLogPayload,
  isTripTerminalForDispatch,
  TERMINAL_TRIP_STATUS_POSTGREST_LIST,
} from "./tripTerminalDispatch.ts";

export type ScheduleDispatchSweepDeps = {
  supabase: SupabaseClient;
  now: Date;
  triggerAutoDispatch: (tripId: string, triggerReason: string) => Promise<{ ok: boolean; data: unknown }>;
  assertPaymentGate: (tripId: string) => Promise<void>;
  isPaymentGateError: (err: unknown) => err is Error;
  logAudit: (event: string, payload: Record<string, unknown>) => Promise<void>;
};

export type ScheduleDispatchSweepResult =
  | { ok: false; status: number; error: string }
  | {
    ok: true;
    processed: number;
    convertedToInstant: number;
    dispatched: number;
    skipped: number;
    errors: number;
    results: Array<{ trip_id: string; action: string; detail?: string }>;
    message?: string;
  };

export async function runScheduleDispatchConversionSweep(
  deps: ScheduleDispatchSweepDeps,
): Promise<ScheduleDispatchSweepResult> {
  const { supabase, now } = deps;
  const nowMs = now.getTime();

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
    return {
      ok: false,
      status: 422,
      error: "No global_dispatch_settings row found. Configure in Admin Panel → Auto-Dispatch Rules.",
    };
  }

  const schedConfig = resolveScheduledDispatchConfig(globalCfg);
  const scheduledEnabled = Boolean(
    (globalCfg as { scheduled_rides_enabled?: boolean }).scheduled_rides_enabled,
  );
  const maxFindDriverMinutes = schedConfig.maxFindDriverMinutes;

  const { data: pendingTrips, error: tripsErr } = await supabase
    .from("trips")
    .select(
      "id, scheduled_at, scheduled_broadcast_at, scheduled_convert_at, pickup_latitude, pickup_longitude, vehicle_type_id, service_area_id, confirmed_driver_id, driver_id, scheduled_status, status, dispatch_status, dispatch_mode, is_scheduled",
    )
    .eq("is_scheduled", true)
    .eq("dispatch_mode", "scheduled")
    .in("scheduled_status", [...NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES])
    .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
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
    return { ok: false, status: 500, error: "Failed to query scheduled trips" };
  }

  if (!pendingTrips || pendingTrips.length === 0) {
    console.log("[schedule-dispatch] No pending scheduled trips found");
    return {
      ok: true,
      processed: 0,
      convertedToInstant: 0,
      dispatched: 0,
      skipped: 0,
      errors: 0,
      results: [],
      message: "No trips to dispatch",
    };
  }

  console.log(`[schedule-dispatch] Found ${pendingTrips.length} candidate trips`);

  const convertTripIds = pendingTrips.map((t: { id: string }) => t.id);
  const { data: convertOffers } = await supabase
    .from("ride_offers")
    .select("trip_id, status, offered_at, created_at")
    .in("trip_id", convertTripIds)
    .order("created_at", { ascending: true });

  const offersByTrip = new Map<string, NonNullable<typeof convertOffers>>();
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
      if (isTripTerminalForDispatch(trip)) {
        console.warn(JSON.stringify(blockedTerminalTripLogPayload(trip, "schedule_dispatch_convert", {
          trip_id: trip.id,
        })));
        skipped++;
        results.push({ trip_id: trip.id, action: "skipped", detail: "terminal_trip" });
        continue;
      }

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
        await deps.assertPaymentGate(trip.id);
      } catch (e) {
        if (deps.isPaymentGateError(e)) {
          console.warn(`[schedule-dispatch] Trip ${trip.id}: PAYMENT_GATE_NOT_SATISFIED — ${e.message}`);
          await supabase.from("trips").update({
            scheduled_status: "payment_gate_blocked",
            updated_at: now.toISOString(),
          })
            .eq("id", trip.id)
            .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST);
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
        .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
        .is("driver_id", null)
        .is("confirmed_driver_id", null)
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
      const dispatchResult = await deps.triggerAutoDispatch(trip.id, triggerReason);

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

      await deps.logAudit("schedule_dispatch_triggered", {
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

  return {
    ok: true,
    processed: pendingTrips.length,
    convertedToInstant,
    dispatched,
    skipped,
    errors,
    results,
  };
}
