/**
 * Repair trips.stops / total_stops from payment_sessions.booking_snapshot
 * when webhook finalize_paid_booking_session created the trip without vias
 * (MK-260916-034). Safe to call on CTAP idempotent returns and post-insert.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { resolveBookingTotalStops } from "./fareQuoteStops.ts";

export async function repairTripStopsFromSession(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    bookingSnapshot?: Record<string, unknown> | null;
    fareSnapshot?: Record<string, unknown> | null;
  },
): Promise<{
  repaired: boolean;
  reason: string;
  total_stops: number;
  via_count: number;
}> {
  const { data: trip, error: tripErr } = await supabase
    .from("trips")
    .select("id, stops, total_stops, payment_session_id")
    .eq("id", args.tripId)
    .maybeSingle();
  if (tripErr || !trip) {
    return { repaired: false, reason: "trip_not_found", total_stops: 0, via_count: 0 };
  }

  const existingVias = Array.isArray(trip.stops) ? trip.stops.length : 0;
  const existingTotal = Number(trip.total_stops ?? 0);
  if (existingVias > 0 && existingTotal > 2) {
    return {
      repaired: false,
      reason: "already_populated",
      total_stops: existingTotal,
      via_count: existingVias,
    };
  }

  let bookingSnap = args.bookingSnapshot ?? null;
  let fareSnap = args.fareSnapshot ?? null;
  if ((!bookingSnap || !fareSnap) && trip.payment_session_id) {
    const { data: session } = await supabase
      .from("payment_sessions")
      .select("booking_snapshot, fare_snapshot")
      .eq("id", trip.payment_session_id)
      .maybeSingle();
    bookingSnap = bookingSnap ??
      ((session?.booking_snapshot as Record<string, unknown> | undefined) ?? null);
    fareSnap = fareSnap ??
      ((session?.fare_snapshot as Record<string, unknown> | undefined) ?? null);
  }

  const fareQuoteId =
    typeof fareSnap?.fare_quote_id === "string"
      ? fareSnap.fare_quote_id
      : typeof fareSnap?.fareQuoteId === "string"
      ? fareSnap.fareQuoteId
      : typeof bookingSnap?.fare_quote_id === "string"
      ? bookingSnap.fare_quote_id
      : typeof bookingSnap?.fareQuoteId === "string"
      ? bookingSnap.fareQuoteId
      : null;

  const { intermediateStops, totalStops } = resolveBookingTotalStops({
    bodyStops: [],
    bookingSnapshotStops: bookingSnap?.stops,
    fareQuoteId,
  });

  if (intermediateStops.length === 0 && totalStops <= 2) {
    return {
      repaired: false,
      reason: "no_snapshot_vias",
      total_stops: existingTotal,
      via_count: 0,
    };
  }

  if (
    intermediateStops.length === existingVias &&
    totalStops === existingTotal
  ) {
    return {
      repaired: false,
      reason: "already_matches",
      total_stops: existingTotal,
      via_count: existingVias,
    };
  }

  const { error: updErr } = await supabase
    .from("trips")
    .update({
      stops: intermediateStops,
      total_stops: totalStops,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.tripId);

  if (updErr) {
    return {
      repaired: false,
      reason: `update_failed:${updErr.message}`,
      total_stops: existingTotal,
      via_count: existingVias,
    };
  }

  // Best-effort materialize trip_stops for Driver stop workflow.
  try {
    await supabase.rpc("ensure_trip_stops_for_assignment", {
      p_trip_id: args.tripId,
    });
  } catch {
    /* non-fatal — trips.stops / total_stops already fixed for +N chip */
  }

  return {
    repaired: true,
    reason: "repaired_from_session",
    total_stops: totalStops,
    via_count: intermediateStops.length,
  };
}
