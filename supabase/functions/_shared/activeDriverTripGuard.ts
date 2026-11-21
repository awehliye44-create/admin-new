/**
 * Active driver trip guard â prevents idle accept hijacking an in-progress trip.
 * Used by auto-dispatch (offer creation) and accept-offer (accept routing).
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

/** Statuses where the driver is actively serving a trip (not queued/stacked child). */
export const ACTIVE_DRIVER_TRIP_STATUSES = [
  "accepted",
  "confirmed",
  "driver_assigned",
  "driver_en_route",
  "driver_arriving",
  "en_route",
  "arrived",
  "arrived_pickup",
  "arrived_at_pickup",
  "at_pickup",
  "waiting_at_pickup",
  "passenger_onboard",
  "in_progress",
] as const;

export function isActiveDriverTripStatus(status: string | null | undefined): boolean {
  const normalized = String(status ?? "").trim().toLowerCase().replace(/-/g, "_");
  return (ACTIVE_DRIVER_TRIP_STATUSES as readonly string[]).includes(normalized);
}

/**
 * Resolve the trip the driver is actively serving (never a queued stacked child).
 * Pass `currentTripIdHint` from an already-loaded drivers row to skip a redundant
 * drivers SELECT (#69A accept-offer pre-RPC collapse).
 */
export async function resolveDriverActiveTripId(
  supabase: SupabaseClient,
  driverId: string,
  currentTripIdHint?: string | null,
): Promise<string | null> {
  let currentTripId =
    typeof currentTripIdHint === "string" && currentTripIdHint.trim()
      ? currentTripIdHint.trim()
      : null;

  if (currentTripId == null) {
    const { data: driver } = await supabase
      .from("drivers")
      .select("current_trip_id")
      .eq("id", driverId)
      .maybeSingle();
    currentTripId =
      typeof driver?.current_trip_id === "string" && driver.current_trip_id.trim()
        ? driver.current_trip_id.trim()
        : null;
  }

  if (currentTripId) {
    const { data: trip } = await supabase
      .from("trips")
      .select("id, status")
      .eq("id", currentTripId)
      .maybeSingle();

    if (trip && isActiveDriverTripStatus(trip.status)) {
      return trip.id;
    }
  }

  const { data: assigned } = await supabase
    .from("trips")
    .select("id, status")
    .eq("confirmed_driver_id", driverId)
    .in("status", [...ACTIVE_DRIVER_TRIP_STATUSES])
    .neq("status", "queued")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (assigned && isActiveDriverTripStatus(assigned.status)) {
    return assigned.id;
  }

  return null;
}

/** Driver IDs with a non-queued active trip assignment â must not receive idle offers. */
export async function loadActiveTripDriverIds(
  supabase: SupabaseClient,
): Promise<Set<string>> {
  const { data } = await supabase
    .from("trips")
    .select("confirmed_driver_id")
    .in("status", [...ACTIVE_DRIVER_TRIP_STATUSES])
    .not("confirmed_driver_id", "is", null);

  const ids = new Set<string>();
  for (const row of data ?? []) {
    const id = row.confirmed_driver_id as string | null;
    if (id) ids.add(id);
  }
  return ids;
}
