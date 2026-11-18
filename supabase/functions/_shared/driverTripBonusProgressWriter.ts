/**
 * Durable trip-bonus progress after a trip is completed.
 *
 * Path (non-blocking for callers that void this):
 * 1) enqueue_driver_trip_bonus_progress — durable, idempotent on trip_id
 *    (also enqueued by DB trigger on status→completed)
 * 2) process_driver_trip_bonus_progress_outbox_trip — best-effort immediate drain
 * Cron sweep retries pending rows. record_driver_trip_bonus_progress never
 * double-counts a trip or double-credits BONUS.
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
): Promise<{ ok: boolean; error?: string; result?: unknown; enqueued?: boolean }> {
  const driverId = String(args.driverId ?? "").trim();
  const tripId = String(args.tripId ?? "").trim();
  if (!driverId || !tripId) {
    return { ok: false, error: "missing_ids" };
  }

  const completedAt = args.completedAt ?? new Date().toISOString();
  const serviceAreaId = args.serviceAreaId ?? null;
  const regionId = args.regionId ?? null;

  const { error: enqueueError } = await supabase.rpc("enqueue_driver_trip_bonus_progress", {
    p_driver_id: driverId,
    p_trip_id: tripId,
    p_service_area_id: serviceAreaId,
    p_region_id: regionId,
    p_completed_at: completedAt,
  });

  if (enqueueError) {
    // Pre-outbox deploy / enqueue hiccup: direct idempotent progress still safe.
    console.warn("[trip-bonus] enqueue failed; trying direct progress", {
      trip_id: tripId,
      driver_id: driverId,
      message: enqueueError.message,
    });
    const direct = await supabase.rpc("record_driver_trip_bonus_progress", {
      p_driver_id: driverId,
      p_trip_id: tripId,
      p_service_area_id: serviceAreaId,
      p_region_id: regionId,
      p_completed_at: completedAt,
    });
    if (direct.error) {
      console.warn("[trip-bonus] record_driver_trip_bonus_progress failed", {
        trip_id: tripId,
        driver_id: driverId,
        message: direct.error.message,
      });
      return { ok: false, error: direct.error.message, enqueued: false };
    }
    return { ok: true, result: direct.data, enqueued: false };
  }

  const { data, error } = await supabase.rpc(
    "process_driver_trip_bonus_progress_outbox_trip",
    { p_trip_id: tripId },
  );

  if (error) {
    console.warn("[trip-bonus] immediate outbox process failed; cron will retry", {
      trip_id: tripId,
      driver_id: driverId,
      message: error.message,
    });
    return { ok: true, error: error.message, enqueued: true };
  }

  return { ok: true, result: data, enqueued: true };
}
