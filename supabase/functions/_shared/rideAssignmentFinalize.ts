/**
 * Post-accept side effects shared by accept-offer and negotiated accept paths.
 * booking_id === trips.id in this codebase.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  ASSIGNED_NEGOTIATION_TRIP_SELECT,
  buildAssignedNegotiationSnapshot,
  type AssignedNegotiationSnapshot,
} from "./assignedNegotiationSnapshot.ts";

export type FinalizeRideAssignmentParams = {
  tripId: string;
  offerId: string;
  driverId: string;
  source: string;
  fareSource?: string | null;
  acceptedVia?: string;
};

const ASSIGNED_TRIP_STATUSES = new Set([
  "accepted",
  "confirmed",
  "driver_assigned",
  "en_route",
  "en_route_to_pickup",
  "driver_en_route",
  "arrived",
  "arrived_pickup",
  "in_progress",
]);

export type FinalizeRideAssignmentResult = {
  ok: boolean;
  tripStatus?: string;
  dispatchStatus?: string | null;
  snapshot?: AssignedNegotiationSnapshot | null;
};

export async function finalizeRideAssignmentSideEffects(
  supabase: SupabaseClient,
  params: FinalizeRideAssignmentParams,
): Promise<FinalizeRideAssignmentResult> {
  const { tripId, offerId, driverId, source, fareSource, acceptedVia } = params;

  console.log("[ride-assignment] NEGOTIATED_ACCEPT_STARTED", {
    trip_id: tripId,
    offer_id: offerId,
    driver_id: driverId,
    source,
    fare_source: fareSource ?? null,
  });
  console.log("[ride-assignment] NORMAL_ASSIGNMENT_FLOW_CALLED", {
    trip_id: tripId,
    via: acceptedVia ?? "accept_ride_offer",
  });

  const { data: tripBefore } = await supabase
    .from("trips")
    .select("id, status, dispatch_status, driver_id")
    .eq("id", tripId)
    .maybeSingle();

  if (!tripBefore?.id) {
    console.error("[ride-assignment] TRIP_ROW_MISSING", { trip_id: tripId });
    return { ok: false };
  }

  console.log("[ride-assignment] TRIP_ROW_EXISTS", {
    trip_id: tripId,
    status: tripBefore.status,
    dispatch_status: tripBefore.dispatch_status,
    driver_id: tripBefore.driver_id,
  });

  const { error: stopsErr } = await supabase.rpc("ensure_trip_stops_for_assignment", {
    p_trip_id: tripId,
  });
  if (stopsErr) {
    console.warn("[ride-assignment] ensure_trip_stops_for_assignment:", stopsErr.message);
  } else {
    console.log("[ride-assignment] TRIP_STOPS_ENSURED", { trip_id: tripId });
  }

  const { error: bdlErr } = await supabase.rpc("record_booking_delivery", {
    p_booking_id: tripId,
    p_phase: "accepted",
    p_driver_id: driverId,
    p_offer_id: offerId,
    p_source: source,
    p_detail: {
      fare_source: fareSource ?? "negotiated_offer",
      accepted_via: acceptedVia ?? "accept_ride_offer",
    },
  });
  if (bdlErr) {
    console.warn("[ride-assignment] record_booking_delivery failed:", bdlErr.message);
  } else {
    console.log("[ride-assignment] BOOKING_ROW_CREATED", {
      booking_id: tripId,
      phase: "accepted",
    });
  }

  try {
    const { data: tripRow } = await supabase
      .from("trips")
      .select("passenger_id, fare, final_fare_pence")
      .eq("id", tripId)
      .maybeSingle();

    let userId: string | null = null;
    if (tripRow?.passenger_id) {
      const { data: cust } = await supabase
        .from("customers")
        .select("user_id")
        .eq("id", tripRow.passenger_id)
        .maybeSingle();
      userId = cust?.user_id ?? tripRow.passenger_id;
    }

    if (userId) {
      const farePence = tripRow?.final_fare_pence ?? 0;
      const fareDisplay = farePence > 0
        ? `£${(farePence / 100).toFixed(2)}`
        : (typeof tripRow?.fare === "number" ? `£${tripRow.fare.toFixed(2)}` : undefined);

      await supabase.functions.invoke("send-trip-notification", {
        body: {
          userId,
          tripId,
          event: "trip_accepted",
          fareDisplay,
        },
      });
      console.log("[ride-assignment] RIDE_ASSIGNED_BROADCASTED", {
        trip_id: tripId,
        event: "trip_accepted",
        user_id: userId,
      });
    }
  } catch (e) {
    console.warn("[ride-assignment] send-trip-notification failed:", e);
  }

  let { data: tripAfter, error: tripAfterErr } = await supabase
    .from("trips")
    .select(ASSIGNED_NEGOTIATION_TRIP_SELECT)
    .eq("id", tripId)
    .maybeSingle();

  if (
    tripAfter?.final_fare_pence
    && tripAfter.commission_pence == null
    && tripAfter.driver_id
  ) {
    const { error: snapshotErr } = await supabase.rpc("snapshot_driver_tier_commission_on_trip", {
      p_trip_id: tripId,
      p_driver_id: tripAfter.driver_id,
    });
    if (snapshotErr) {
      console.warn("[ride-assignment] snapshot_driver_tier_commission_on_trip retry:", snapshotErr.message);
    } else {
      const { data: tripAfterSnapshot } = await supabase
        .from("trips")
        .select(ASSIGNED_NEGOTIATION_TRIP_SELECT)
        .eq("id", tripId)
        .maybeSingle();
      if (tripAfterSnapshot) {
        tripAfter = tripAfterSnapshot;
      }
    }
  }

  if (tripAfter?.final_fare_pence) {
    console.log("[ride-assignment] NEGOTIATION_RESOLVED_DRIVER", {
      trip_id: tripId,
      offer_id: offerId,
      driver_id: driverId,
      final_fare_pence: tripAfter.final_fare_pence,
      fare_source: (tripAfter.fare_snapshot_json as { fare_source?: string } | null)?.fare_source ?? fareSource,
      commission_pence: tripAfter.commission_pence,
      driver_net_pence: tripAfter.driver_net_pence,
      tier_commission_percent: tripAfter.driver_tier_commission_percent,
    });
    console.log("[ride-assignment] FINAL_FARE_SET", {
      trip_id: tripId,
      final_fare_pence: tripAfter.final_fare_pence,
      fare_source: (tripAfter.fare_snapshot_json as { fare_source?: string } | null)?.fare_source ?? null,
    });
    if (tripAfter.commission_pence != null) {
      console.log("[ride-assignment] COMMISSION_RECALCULATED", {
        trip_id: tripId,
        commission_pence: tripAfter.commission_pence,
        driver_net_pence: tripAfter.driver_net_pence,
      });
      console.log("[ride-assignment] TIER_COMMISSION_USED", {
        trip_id: tripId,
        tier_commission_percent: tripAfter.driver_tier_commission_percent,
      });
      console.log("[ride-assignment] DRIVER_NET_UPDATED", {
        trip_id: tripId,
        driver_net_pence: tripAfter.driver_net_pence,
      });
    } else {
      console.warn("[ride-assignment] COMMISSION_MISSING_AFTER_ACCEPT", { trip_id: tripId });
    }
  }

  if (tripAfterErr || !tripAfter) {
    console.error("[ride-assignment] ADMIN_ACTIVE_RECORD_VISIBLE failed:", tripAfterErr?.message);
    return { ok: false };
  }

  const adminVisible = !!(
    tripAfter.driver_id
    && (ASSIGNED_TRIP_STATUSES.has(String(tripAfter.status ?? ""))
      || tripAfter.dispatch_status === "assigned")
  );

  console.log("[ride-assignment] ADMIN_ACTIVE_RECORD_VISIBLE", {
    trip_id: tripId,
    status: tripAfter.status,
    dispatch_status: tripAfter.dispatch_status,
    driver_id: tripAfter.driver_id,
    visible: adminVisible,
  });

  if (adminVisible) {
    console.log("[ride-assignment] EXPIRY_CANCELLED", {
      trip_id: tripId,
      note: "assigned trip; expire-offers must skip via status/driver_id guards",
    });
    console.log("TRIP_CONFIRMED_FROM_ACCEPTED_OFFER", {
      trip_id: tripId,
      offer_id: offerId,
      driver_id: driverId,
      status: tripAfter.status,
    });
    console.log("TRIP_DRIVER_ASSIGNED", {
      trip_id: tripId,
      driver_id: tripAfter.driver_id,
      dispatch_status: tripAfter.dispatch_status,
    });
  }

  return {
    ok: adminVisible,
    tripStatus: tripAfter.status ?? undefined,
    dispatchStatus: tripAfter.dispatch_status,
    snapshot: buildAssignedNegotiationSnapshot(
      tripAfter as Record<string, unknown>,
      { fareSource, tripId },
    ),
  };
}
