/**
 * Auto-unlock scheduled early Arrived → eligible waiting at scheduled_at.
 * No second Arrived press; server cron / scheduled-dispatch owns the transition.
 */

import { eligibleFromMsForPickupTrip } from "./scheduledPickupWaitingFairnessSSOT.ts";
import {
  resolveEffectiveWaitingRadiusMeters,
  syncWaitingGeofenceClock,
} from "./waitingSegmentClock.ts";

export function isScheduledEarlyArrivalDueForUnlock(input: {
  nowMs: number;
  status: string | null | undefined;
  scheduledAtIso: string | null | undefined;
  pickupWaitingStartedAt: string | null | undefined;
  startedAt: string | null | undefined;
  pickupWaitingFinalizedAt?: string | null;
}): boolean {
  if (input.startedAt) return false;
  if (input.pickupWaitingFinalizedAt) return false;
  const status = String(input.status ?? "").trim().toLowerCase();
  if (
    status !== "arrived_at_pickup" &&
    status !== "arrived" &&
    status !== "at_pickup" &&
    status !== "waiting" &&
    status !== "waiting_at_pickup" &&
    status !== "pickup_waiting"
  ) {
    return false;
  }
  if (!input.pickupWaitingStartedAt) return false;
  const scheduledMs = input.scheduledAtIso
    ? Date.parse(String(input.scheduledAtIso))
    : NaN;
  if (!Number.isFinite(scheduledMs)) return false;
  return input.nowMs >= scheduledMs;
}

/**
 * Sync pickup geofence once scheduled_at has passed so eligible waiting can
 * open automatically when the driver is inside the radius with fresh GPS.
 */
// deno-lint-ignore no-explicit-any
export async function unlockScheduledEarlyArrivalWaiting(
  supabase: any,
  trip: {
    id: string;
    driver_id?: string | null;
    confirmed_driver_id?: string | null;
    arrived_at?: string | null;
    pickup_arrived_at?: string | null;
    scheduled_at?: string | null;
    is_scheduled?: boolean | null;
    pickup_latitude?: number | null;
    pickup_longitude?: number | null;
    pickup_radius_meters?: number | null;
    pickup_radius_enabled?: boolean | null;
  },
  nowIso: string,
): Promise<{ unlocked: boolean; status: string | null; countedSeconds: number }> {
  const driverId = String(trip.driver_id ?? trip.confirmed_driver_id ?? "").trim();
  if (!driverId) return { unlocked: false, status: null, countedSeconds: 0 };
  if (trip.pickup_latitude == null || trip.pickup_longitude == null) {
    return { unlocked: false, status: null, countedSeconds: 0 };
  }

  const eligibleFromMs = eligibleFromMsForPickupTrip(trip);
  const radiusEnabled = trip.pickup_radius_enabled !== false;
  const radiusMeters = resolveEffectiveWaitingRadiusMeters(
    trip.pickup_radius_meters ?? 150,
    radiusEnabled,
  );

  const clock = await syncWaitingGeofenceClock(supabase, {
    tripId: trip.id,
    driverId,
    locationType: "pickup",
    target: {
      lat: Number(trip.pickup_latitude),
      lng: Number(trip.pickup_longitude),
      radiusMeters,
      radiusEnabled,
    },
    nowIso,
    eligibleFromMs,
  });

  // Persist awaiting → free/counting transition on trip waiting state when due.
  if (!clock.awaitingScheduledPickup) {
    await supabase
      .from("trips")
      .update({
        waiting_geofence_status: clock.status,
        pickup_waiting_counted_seconds: clock.countedSeconds,
        updated_at: nowIso,
      })
      .eq("id", trip.id)
      .is("started_at", null);
  }

  return {
    unlocked: !clock.awaitingScheduledPickup,
    status: clock.status,
    countedSeconds: clock.countedSeconds,
  };
}
