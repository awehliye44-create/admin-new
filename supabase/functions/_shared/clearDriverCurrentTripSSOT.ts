/**
 * #118 — CAS clear of drivers.current_trip_id for a specific trip.
 * Never clears a newer assignment (eq current_trip_id = tripId).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

export async function clearDriverCurrentTripIfMatches(
  supabase: SupabaseClient,
  args: { driverId: string; tripId: string },
): Promise<{ cleared: boolean; error: string | null }> {
  const driverId = String(args.driverId ?? "").trim();
  const tripId = String(args.tripId ?? "").trim();
  if (!driverId || !tripId) {
    return { cleared: false, error: "missing_ids" };
  }

  const { data, error } = await supabase
    .from("drivers")
    .update({ current_trip_id: null, updated_at: new Date().toISOString() })
    .eq("id", driverId)
    .eq("current_trip_id", tripId)
    .select("id");

  if (error) {
    return { cleared: false, error: error.message };
  }
  return { cleared: Array.isArray(data) && data.length > 0, error: null };
}

/** Prefer DB RPC when available (same CAS semantics). */
export async function reconcileStaleDriverCurrentTrip(
  supabase: SupabaseClient,
  args?: { driverId?: string | null; limit?: number },
): Promise<{ clearedCount: number; raw: unknown }> {
  const { data, error } = await supabase.rpc("reconcile_stale_driver_current_trip", {
    p_driver_id: args?.driverId ?? null,
    p_limit: args?.limit ?? 100,
  });
  if (error) {
    console.warn("[clearDriverCurrentTripSSOT] reconcile_stale_driver_current_trip failed", {
      message: error.message,
    });
    return { clearedCount: 0, raw: { error: error.message } };
  }
  const clearedCount =
    data && typeof data === "object" && typeof (data as { cleared_count?: unknown }).cleared_count === "number"
      ? (data as { cleared_count: number }).cleared_count
      : 0;
  return { clearedCount, raw: data };
}
