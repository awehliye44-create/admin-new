import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertGlobalRebroadcastAllowed } from "./rebroadcastPolicy.ts";
import { notifyCustomerTripLifecycle } from "./customerTripLifecycleNotify.ts";
import { FINDING_ANOTHER_DRIVER_UPDATED_FARE_BODY } from "./negotiationPushCopy.ts";

export type FinalizeNegotiationFailureParams = {
  tripId: string;
  failedDriverId: string;
  offerId?: string | null;
  offerTerminalStatus?: "expired" | "declined" | "revoked";
  offerNegotiationStatus?: string;
};

export type FinalizeNegotiationFailureResult = {
  success: boolean;
  trip_id?: string;
  error?: string;
  skipped?: boolean;
  rebroadcast_skipped?: boolean;
};

/**
 * Same trip_id global rebroadcast after negotiation failure.
 * Never creates a new trip/booking.
 * After authoritative rematch, Customer gets finding-another-driver (never trip_cancelled).
 */
export async function finalizeNegotiationFailureAndRebroadcast(
  supabase: SupabaseClient,
  params: FinalizeNegotiationFailureParams,
): Promise<FinalizeNegotiationFailureResult> {
  const { data, error } = await supabase.rpc("finalize_negotiation_failure", {
    p_trip_id: params.tripId,
    p_failed_driver_id: params.failedDriverId,
    p_offer_id: params.offerId ?? null,
    p_offer_terminal_status: params.offerTerminalStatus ?? "expired",
    p_offer_negotiation_status: params.offerNegotiationStatus ?? "failed",
  });

  if (error) {
    console.error("[negotiationFailureRematch] RPC error:", error);
    return { success: false, error: error.message };
  }

  const row = data as {
    success?: boolean;
    trip_id?: string;
    skipped?: boolean;
    error?: string;
  } | null;

  if (!row?.success) {
    return {
      success: false,
      error: row?.error ?? "finalize_negotiation_failure failed",
    };
  }

  if (row.skipped) {
    return { success: true, trip_id: row.trip_id, skipped: true };
  }

  console.log("[negotiationFailureRematch] DRIVER_EXCLUDED_FROM_TRIP", {
    trip_id: params.tripId,
    failed_driver_id: params.failedDriverId,
    offer_id: params.offerId ?? null,
    offer_terminal_status: params.offerTerminalStatus ?? "expired",
  });

  const allowed = await assertGlobalRebroadcastAllowed(
    supabase,
    params.tripId,
    "finalizeNegotiationFailureAndRebroadcast",
  );
  if (allowed) {
    await rebroadcastSameTrip(supabase, params.tripId);
  }

  const tripId = row.trip_id ?? params.tripId;
  await notifyCustomerNegotiationRematch(supabase, tripId);

  return { success: true, trip_id: tripId, rebroadcast_skipped: !allowed };
}

/** Customer heads-up after negotiation rematch — not trip_cancelled. */
export async function notifyCustomerNegotiationRematch(
  supabase: SupabaseClient,
  tripId: string,
): Promise<void> {
  try {
    const { data: trip } = await supabase
      .from("trips")
      .select("passenger_id")
      .eq("id", tripId)
      .maybeSingle();
    const passengerId =
      typeof trip?.passenger_id === "string" ? trip.passenger_id.trim() : "";
    if (!passengerId) return;

    await notifyCustomerTripLifecycle(supabase, {
      passengerId,
      tripId,
      event: "finding_another_driver_updated_fare",
      title: "Finding another driver",
      body: FINDING_ANOTHER_DRIVER_UPDATED_FARE_BODY,
      notificationId: `finding_another_driver-${tripId}`,
    });
  } catch (e) {
    console.warn("[negotiationFailureRematch] customer finding-another push failed:", e);
  }
}

/** Invoke global dispatch for an already-finalized trip (same trip_id, never a new booking). */
export async function rebroadcastSameTrip(
  supabase: SupabaseClient,
  tripId: string,
): Promise<void> {
  const allowed = await assertGlobalRebroadcastAllowed(supabase, tripId, "rebroadcastSameTrip");
  if (!allowed) return;

  // Single dispatch orchestrator: auto-dispatch edge function only.
  // REMOVED: dispatch_trip_offers SQL RPC fallback (created un-audited, presetless offers).
  try {
    const { error: dispatchErr } = await supabase.functions.invoke("auto-dispatch", {
      body: {
        trip_id: tripId,
        force_rebroadcast: true,
        trigger_reason: "negotiation_failure_rematch",
      },
    });
    if (!dispatchErr) {
      console.log("[negotiationFailureRematch] REBROADCAST_SAME_TRIP auto-dispatch", { trip_id: tripId });
    } else {
      console.error("[negotiationFailureRematch] auto-dispatch rebroadcast failed:", dispatchErr.message);
    }
  } catch (e) {
    console.error("[negotiationFailureRematch] auto-dispatch invoke failed:", e);
  }
}
