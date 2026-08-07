/**
 * Shared helpers for pickup waiting / no-show edge functions.
 * Stop-workflow sets status `arrived_pickup` and often records arrival on trip_stops only.
 */

/** Driver at pickup, trip not yet started — canonical + aliases seen in DB / migrations */
export function isTripAtPickupStatus(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return (
    s === "arrived" ||
    s === "arrived_pickup" ||
    s === "arrived_at_pickup" ||
    s === "at_pickup" ||
    s === "pickup_waiting" ||
    s === "waiting" ||
    s === "driver_arrived" ||
    s === "waiting_at_pickup"
  );
}

/**
 * Prefer trips.arrived_at; if missing (legacy stop-workflow), use pickup stop (index 0) arrived_at.
 */
// deno-lint-ignore no-explicit-any
export async function resolvePickupArrivedAtIso(supabase: any, tripId: string, tripRowArrivedAt: string | null | undefined): Promise<string | null> {
  if (tripRowArrivedAt) return tripRowArrivedAt;
  const { data: stop } = await supabase
    .from("trip_stops")
    .select("arrived_at")
    .eq("trip_id", tripId)
    .eq("stop_index", 0)
    .maybeSingle();
  return stop?.arrived_at ?? null;
}

/** Canonical pickup arrival anchor — pickup_arrived_at / arrived_at / pickup stop (index 0). */
export async function resolveDriverArrivedAtIso(
  supabase: any,
  tripId: string,
  trip: {
    pickup_arrived_at?: string | null;
    arrived_at?: string | null;
  },
): Promise<string | null> {
  const direct = trip.pickup_arrived_at ?? trip.arrived_at ?? null;
  if (direct) return direct;
  return resolvePickupArrivedAtIso(supabase, tripId, null);
}
