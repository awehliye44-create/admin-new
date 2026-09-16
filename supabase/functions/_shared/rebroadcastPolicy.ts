/**
 * HARD RULE — global rebroadcast only after DRIVER-side negotiation failure.
 *
 * Valid: driver countdown expired, driver declined, driver negotiation timeout,
 * driver cancelled preset, driver ignored counter until timeout.
 *
 * Invalid: customer counter-offer, customer accept, customer waiting, active negotiation.
 */
import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/** Negotiation states where ride stays locked to driver — no global rebroadcast. */
export const ACTIVE_DRIVER_NEGOTIATION_STATUSES = new Set([
  "waiting_customer",
  "waiting_driver_final",
  "declined_customer_awaiting_driver",
  "waiting_driver",
  "driver_offered",
]);

export type RebroadcastBlockReason =
  | "active_negotiation_offer"
  | "trip_dispatch_paused"
  | "trip_already_assigned"
  | null;

export async function getActiveNegotiationOffer(
  supabase: SupabaseClient,
  tripId: string,
): Promise<{
  id: string;
  driver_id: string | null;
  negotiation_status: string | null;
  status: string | null;
} | null> {
  const { data } = await supabase
    .from("ride_offers")
    .select("id, driver_id, negotiation_status, status")
    .eq("trip_id", tripId)
    .in("status", ["pending", "countered"])
    .in("negotiation_status", [...ACTIVE_DRIVER_NEGOTIATION_STATUSES])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data ?? null;
}

/**
 * Returns whether global rebroadcast must NOT run (customer counter / waiting / active negotiation).
 */
export async function shouldBlockGlobalRebroadcast(
  supabase: SupabaseClient,
  tripId: string,
): Promise<{ block: boolean; reason: RebroadcastBlockReason }> {
  const { data: trip } = await supabase
    .from("trips")
    .select("id, status, dispatch_status, broadcast_enabled, driver_id, negotiation_status")
    .eq("id", tripId)
    .maybeSingle();

  if (!trip) {
    return { block: false, reason: null };
  }

  // finalize_negotiation_failure already unlocked this trip for global dispatch.
  if (
    trip.status === "searching_new_driver"
    || trip.negotiation_status === "failed"
  ) {
    return { block: false, reason: null };
  }

  if (
    trip.driver_id
    && ["accepted", "confirmed", "driver_assigned", "arrived_pickup", "arrived", "in_progress"]
      .includes(trip.status ?? "")
  ) {
    return { block: true, reason: "trip_already_assigned" };
  }

  if (trip.dispatch_status === "paused" || trip.broadcast_enabled === false) {
    const activeOffer = await getActiveNegotiationOffer(supabase, tripId);
    if (activeOffer) {
      return { block: true, reason: "trip_dispatch_paused" };
    }
  }

  const activeOffer = await getActiveNegotiationOffer(supabase, tripId);
  if (activeOffer) {
    return { block: true, reason: "active_negotiation_offer" };
  }

  return { block: false, reason: null };
}

export async function assertGlobalRebroadcastAllowed(
  supabase: SupabaseClient,
  tripId: string,
  context: string,
): Promise<boolean> {
  const { block, reason } = await shouldBlockGlobalRebroadcast(supabase, tripId);
  if (block) {
    console.log("[rebroadcastPolicy] BLOCKED global rebroadcast", {
      context,
      trip_id: tripId,
      reason,
    });
    return false;
  }
  return true;
}
