import { type SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { computeLiveTripFarePreview } from "./liveTripFareSSOT.ts";

/** Normalized trip_updated payload for customer + driver + admin active cards. */
export type TripUpdatedBroadcastPayload = {
  /** Canonical trip id (also mirrored as trip_id). */
  tripId: string;
  trip_id: string;
  fare: number | null;
  totalFare: number | null;
  baseFare: number | null;
  airportCharge: number | null;
  fareBreakdown: Record<string, unknown> | null;
  distance: number | null;
  duration: number | null;
  pickup?: {
    address: string | null;
    lat: number | null;
    lng: number | null;
  } | null;
  pickupAddress?: string | null;
  pickupLat?: number | null;
  pickupLng?: number | null;
  dropoffAddress: string | null;
  dropoffLat?: number | null;
  dropoffLng?: number | null;
  /** Authoritative trip_stops rows (same as tripStops). */
  stops: unknown[] | null;
  tripStops: unknown[] | null;
  pricingMode: string | null;
  updatedAt: string | null;
  updated_at?: string | null;
  routePolyline?: string | null;
  route_polyline?: string | null;
  modifiedDropoffAddress?: string | null;
  modifiedDropoffLatitude?: number | null;
  modifiedDropoffLongitude?: number | null;
  customerModificationChargePence?: number | null;
  modificationDeltaPence?: number | null;
  modificationStatus?: string | null;
  modification_status?: string | null;
  finalCustomerFarePence?: number | null;
  final_customer_fare_pence?: number | null;
  currentCustomerTotalPence?: number | null;
  current_customer_total_pence?: number | null;
  approvedModificationDeltaPence?: number | null;
  approved_modification_delta_pence?: number | null;
  pickupWaitingChargePence?: number | null;
  stopWaitingChargePence?: number | null;
  driverNetPreviewPence?: number | null;
  driver_net_preview_pence?: number | null;
  fareDeltaPence?: number | null;
  fare_delta_pence?: number | null;
  paymentConfirmationStatus?: string | null;
  driverApprovalStatus?: string | null;
  openModificationRequestId?: string | null;
  currentActiveStopSequence?: number | null;
  current_active_stop_sequence?: number | null;
  lockedPastStopIds?: string[] | null;
  locked_past_stop_ids?: string[] | null;
  editableFutureStopIds?: string[] | null;
  editable_future_stop_ids?: string[] | null;
  routeCacheVersion?: string | null;
  /** Trip lifecycle SSOT — required for customer active card when postgres realtime is delayed. */
  status?: string | null;
  dispatch_status?: string | null;
  driver_id?: string | null;
  confirmed_driver_id?: string | null;
  arrived_at?: string | null;
  pickup_arrived_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  current_stop_index?: number | null;
};

function toMajorUnits(pence: unknown): number | null {
  const n = Number(pence);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n) / 100;
}

function readAirportCharge(breakdown: Record<string, unknown> | null): number | null {
  if (!breakdown) return null;
  const major =
    breakdown.airportCharge ??
    breakdown.airport_charge ??
    (breakdown.airport_charge_pence != null
      ? Number(breakdown.airport_charge_pence) / 100
      : null);
  const n = Number(major);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export type TripUpdatedPayloadExtras = {
  routePolyline?: string | null;
  stops?: unknown[] | null;
  paymentConfirmationStatus?: string | null;
  driverApprovalStatus?: string | null;
  routeCacheVersion?: string | null;
  fareDeltaPence?: number | null;
  modificationStatus?: string | null;
  openModificationRequestId?: string | null;
};

/** Build a camelCase broadcast payload from a trips row (+ optional polyline / open-mod SSOT). */
export function normalizeTripUpdatedPayload(
  trip: Record<string, unknown>,
  extras?: TripUpdatedPayloadExtras,
): TripUpdatedBroadcastPayload {
  const breakdown =
    (trip.fare_breakdown as Record<string, unknown> | null) ??
    (trip.fare_snapshot_json as Record<string, unknown> | null) ??
    null;

  const fareMajor =
    trip.fare != null && Number(trip.fare) > 0
      ? Number(trip.fare)
      : trip.estimated_fare != null && Number(trip.estimated_fare) > 0
        ? Number(trip.estimated_fare)
        : toMajorUnits(trip.final_fare_pence) ??
          toMajorUnits(trip.estimated_total_pence) ??
          toMajorUnits(trip.gross_fare_pence);

  const lockedDisplayPence =
    trip.fare_locked === true
      ? Number(trip.final_customer_fare_pence ?? trip.final_fare_pence ?? 0)
      : 0;

  const totalFareMajor =
    lockedDisplayPence > 0
      ? lockedDisplayPence / 100
      : toMajorUnits(trip.final_fare_pence) ??
        toMajorUnits(trip.estimated_total_pence) ??
        (trip.fare != null && Number(trip.fare) > 0
          ? Number(trip.fare)
          : trip.estimated_fare != null
            ? Number(trip.estimated_fare)
            : null);

  const baseFareMajor =
    trip.base_fare_pence != null && Number(trip.base_fare_pence) > 0
      ? Number(trip.base_fare_pence) / 100
      : breakdown?.tripFare != null
        ? Number(breakdown.tripFare)
        : breakdown?.trip_fare != null
          ? Number(breakdown.trip_fare)
          : null;

  const stops =
    extras?.stops ??
    (Array.isArray(trip.stops) ? trip.stops : null);

  const liveFare = computeLiveTripFarePreview({
    final_customer_fare_pence: trip.final_customer_fare_pence as number | null,
    final_fare_pence: trip.final_fare_pence as number | null,
    locked_base_fare_pence: trip.locked_base_fare_pence as number | null,
    pickup_waiting_charge_pence: trip.pickup_waiting_charge_pence as number | null,
    stop_waiting_charge_pence: trip.stop_waiting_charge_pence as number | null,
    stop_charge_total_pence: trip.stop_charge_total_pence as number | null,
    customer_modification_charge_pence: trip.customer_modification_charge_pence as number | null,
    modification_delta_pence: trip.modification_delta_pence as number | null,
    driver_tier_commission_percent: trip.driver_tier_commission_percent as number | null,
    commission_pct: trip.commission_pct as number | null,
    commission_pence: trip.commission_pence as number | null,
    gross_fare_pence: trip.gross_fare_pence as number | null,
  });

  const stopRows = Array.isArray(stops) ? stops as Array<Record<string, unknown>> : [];
  const lockedPastStopIds = stopRows
    .filter((s) => ["completed", "skipped", "arrived"].includes(String(s.status ?? "").toLowerCase()))
    .map((s) => String(s.id))
    .filter(Boolean);
  const currentActiveStopSequence = stopRows.find((s) =>
    !["completed", "skipped", "arrived"].includes(String(s.status ?? "").toLowerCase())
    && s.type !== "pickup"
  )?.stop_index as number | undefined
    ?? stopRows.find((s) =>
      !["completed", "skipped", "arrived"].includes(String(s.status ?? "").toLowerCase())
    )?.stop_index as number | undefined
    ?? (trip.current_stop_index != null ? Number(trip.current_stop_index) : null);
  const editableFutureStopIds = stopRows
    .filter((s) => {
      const status = String(s.status ?? "").toLowerCase();
      if (["completed", "skipped", "arrived"].includes(status)) return false;
      if (s.type === "pickup") return false;
      if (
        currentActiveStopSequence != null
        && Number(s.stop_index ?? 0) < Number(currentActiveStopSequence)
      ) {
        return false;
      }
      return Boolean(s.id);
    })
    .map((s) => String(s.id));

  const tripId = String(trip.id ?? "");
  const pickupAddress =
    typeof trip.pickup_address === "string" ? trip.pickup_address : null;
  const pickupLat =
    trip.pickup_latitude != null ? Number(trip.pickup_latitude) : null;
  const pickupLng =
    trip.pickup_longitude != null ? Number(trip.pickup_longitude) : null;
  const dropoffAddress =
    typeof trip.modified_dropoff_address === "string"
      ? trip.modified_dropoff_address
      : typeof trip.dropoff_address === "string"
        ? trip.dropoff_address
        : null;
  const dropoffLat =
    trip.modified_dropoff_latitude != null
      ? Number(trip.modified_dropoff_latitude)
      : trip.dropoff_latitude != null
        ? Number(trip.dropoff_latitude)
        : null;
  const dropoffLng =
    trip.modified_dropoff_longitude != null
      ? Number(trip.modified_dropoff_longitude)
      : trip.dropoff_longitude != null
        ? Number(trip.dropoff_longitude)
        : null;
  const modificationStatus =
    typeof extras?.modificationStatus === "string"
      ? extras.modificationStatus
      : typeof trip.modification_status === "string"
        ? trip.modification_status
        : null;
  const fareDeltaPence =
    extras?.fareDeltaPence != null
      ? Number(extras.fareDeltaPence)
      : trip.modification_delta_pence != null
        ? Number(trip.modification_delta_pence)
        : null;
  const updatedAt = typeof trip.updated_at === "string" ? trip.updated_at : null;
  const routePolyline = extras?.routePolyline ?? null;
  const tripStopsRows = Array.isArray(stops) ? stops : null;

  return {
    tripId,
    trip_id: tripId,
    status: typeof trip.status === "string" ? trip.status : null,
    dispatch_status: typeof trip.dispatch_status === "string" ? trip.dispatch_status : null,
    driver_id: typeof trip.driver_id === "string" ? trip.driver_id : null,
    confirmed_driver_id:
      typeof trip.confirmed_driver_id === "string" ? trip.confirmed_driver_id : null,
    arrived_at: typeof trip.arrived_at === "string" ? trip.arrived_at : null,
    pickup_arrived_at:
      typeof trip.pickup_arrived_at === "string" ? trip.pickup_arrived_at : null,
    started_at: typeof trip.started_at === "string" ? trip.started_at : null,
    completed_at: typeof trip.completed_at === "string" ? trip.completed_at : null,
    current_stop_index:
      trip.current_stop_index != null ? Number(trip.current_stop_index) : null,
    fare: fareMajor,
    totalFare: totalFareMajor,
    baseFare: baseFareMajor,
    airportCharge: readAirportCharge(breakdown),
    fareBreakdown: breakdown,
    distance:
      trip.estimated_distance_km != null ? Number(trip.estimated_distance_km) : null,
    duration:
      trip.estimated_duration_minutes != null
        ? Number(trip.estimated_duration_minutes)
        : null,
    pickup: {
      address: pickupAddress,
      lat: pickupLat,
      lng: pickupLng,
    },
    pickupAddress,
    pickupLat,
    pickupLng,
    dropoffAddress,
    dropoffLat,
    dropoffLng,
    modifiedDropoffAddress:
      typeof trip.modified_dropoff_address === "string"
        ? trip.modified_dropoff_address
        : null,
    modifiedDropoffLatitude:
      typeof trip.modified_dropoff_address === "string"
        ? (trip.modified_dropoff_latitude != null
          ? Number(trip.modified_dropoff_latitude)
          : dropoffLat)
        : null,
    modifiedDropoffLongitude:
      typeof trip.modified_dropoff_address === "string"
        ? (trip.modified_dropoff_longitude != null
          ? Number(trip.modified_dropoff_longitude)
          : dropoffLng)
        : null,
    customerModificationChargePence:
      trip.customer_modification_charge_pence != null
        ? Number(trip.customer_modification_charge_pence)
        : null,
    modificationDeltaPence:
      trip.modification_delta_pence != null
        ? Number(trip.modification_delta_pence)
        : null,
    modificationStatus,
    modification_status: modificationStatus,
    finalCustomerFarePence: liveFare.final_customer_fare_pence,
    final_customer_fare_pence: liveFare.final_customer_fare_pence,
    currentCustomerTotalPence: liveFare.current_customer_total_pence,
    current_customer_total_pence: liveFare.current_customer_total_pence,
    approvedModificationDeltaPence: liveFare.approved_modification_delta_pence,
    approved_modification_delta_pence: liveFare.approved_modification_delta_pence,
    pickupWaitingChargePence: liveFare.pickup_waiting_charge_pence,
    stopWaitingChargePence: liveFare.stop_waiting_charge_pence,
    driverNetPreviewPence: liveFare.driver_net_preview_pence,
    driver_net_preview_pence: liveFare.driver_net_preview_pence,
    fareDeltaPence,
    fare_delta_pence: fareDeltaPence,
    paymentConfirmationStatus: extras?.paymentConfirmationStatus ?? null,
    driverApprovalStatus: extras?.driverApprovalStatus ?? null,
    openModificationRequestId: extras?.openModificationRequestId ?? null,
    currentActiveStopSequence: currentActiveStopSequence ?? null,
    current_active_stop_sequence: currentActiveStopSequence ?? null,
    lockedPastStopIds,
    locked_past_stop_ids: lockedPastStopIds,
    editableFutureStopIds,
    editable_future_stop_ids: editableFutureStopIds,
    stops: tripStopsRows,
    tripStops: tripStopsRows,
    pricingMode:
      typeof trip.pricing_mode === "string"
        ? trip.pricing_mode
        : typeof breakdown?.pricing_mode === "string"
          ? breakdown.pricing_mode
          : null,
    updatedAt,
    updated_at: updatedAt,
    routePolyline,
    route_polyline: routePolyline,
    routeCacheVersion: extras?.routeCacheVersion ?? null,
  };
}

/**
 * Realtime broadcast on trip:{tripId}, event trip_updated.
 * Complements postgres_changes on trips UPDATE.
 */
export async function broadcastTripUpdated(
  supabase: SupabaseClient,
  payload: TripUpdatedBroadcastPayload,
): Promise<void> {
  const tripId = payload.tripId;
  if (!tripId) return;

  const channelName = `trip:${tripId}`;
  const channel = supabase.channel(channelName);

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      console.warn("[tripUpdatedBroadcast] subscribe timeout", channelName);
      void supabase.removeChannel(channel);
      resolve();
    }, 3000);

    channel.subscribe((status) => {
      if (status !== "SUBSCRIBED") return;
      clearTimeout(timeout);
      void channel
        .send({
          type: "broadcast",
          event: "trip_updated",
          payload,
        })
        .then(() => {
          console.log("[tripUpdatedBroadcast] sent", { tripId, updatedAt: payload.updatedAt });
        })
        .catch((e) => {
          console.warn("[tripUpdatedBroadcast] send failed:", e);
        })
        .finally(() => {
          void supabase.removeChannel(channel);
          resolve();
        });
    });
  });
}

/** After stop-workflow lifecycle writes — push status SSOT on existing trip_updated channel. */
export async function broadcastTripLifecycleUpdated(
  supabase: SupabaseClient,
  tripId: string,
): Promise<void> {
  if (!tripId) return;
  const { data: trip, error: tripErr } = await supabase
    .from("trips")
    .select("*")
    .eq("id", tripId)
    .maybeSingle();
  if (tripErr || !trip) {
    console.warn("[tripUpdatedBroadcast] lifecycle fetch failed", { tripId, error: tripErr?.message });
    return;
  }
  const { data: stops } = await supabase
    .from("trip_stops")
    .select("*")
    .eq("trip_id", tripId)
    .order("stop_index", { ascending: true });
  const payload = buildTripUpdatedBroadcastPayload(trip as Record<string, unknown>, {
    stops: stops ?? [],
  });
  await broadcastTripUpdated(supabase, payload);
  console.log("[tripUpdatedBroadcast] lifecycle", {
    tripId,
    status: payload.status ?? null,
    updatedAt: payload.updatedAt ?? null,
  });
}
