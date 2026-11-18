/**
 * Fire-and-forget trip-bonus progress after a trip is durably completed.
 * Credits BONUS via SQL RPC record_driver_trip_bonus_progress (idempotent).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export async function recordTripBonusProgressAfterCompletion(
  supabase: SupabaseClient,
  args: {
    driverId: string;
    tripId: string;
    serviceAreaId?: string | null;
    regionId?: string | null;
    completedAt?: string | null;
  },
): Promise<{ ok: boolean; error?: string; result?: unknown }> {
  const driverId = String(args.driverId ?? "").trim();
  const tripId = String(args.tripId ?? "").trim();
  if (!driverId || !tripId) {
    return { ok: false, error: "missing_ids" };
  }

  const { data, error } = await supabase.rpc("record_driver_trip_bonus_progress", {
    p_driver_id: driverId,
    p_trip_id: tripId,
    p_service_area_id: args.serviceAreaId ?? null,
    p_region_id: args.regionId ?? null,
    p_completed_at: args.completedAt ?? new Date().toISOString(),
  });

  if (error) {
    console.warn("[trip-bonus] record_driver_trip_bonus_progress failed", {
      trip_id: tripId,
      driver_id: driverId,
      message: error.message,
    });
    return { ok: false, error: error.message };
  }

  return { ok: true, result: data };
}
