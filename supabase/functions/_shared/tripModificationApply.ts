import { type SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  fareBreakdownToTripSnapshot,
  negotiationBaseFarePenceFromBreakdown,
  type FareBreakdown,
} from "./pricing-engine.ts";
import {
  broadcastTripUpdated,
  normalizeTripUpdatedPayload,
} from "./tripUpdatedBroadcast.ts";
import { notifyDriverTripModified } from "./notifyDriverTripModified.ts";

export type FarePreviewSnapshot = {
  new_fare_pence: number;
  new_distance_meters: number;
  new_duration_seconds: number;
  fare_breakdown?: FareBreakdown;
  fare_breakdown_json?: Record<string, unknown>;
  pricing_mode?: string | null;
  base_fare_pence?: number | null;
  polyline?: string | null;
};

/** Persist estimate-fare + route preview on the after_route_snapshot for the DB trigger. */
export function buildFarePreviewSnapshot(
  estimatePayload: Record<string, unknown>,
  routePayload: Record<string, unknown>,
  newFarePence: number,
  newDistanceMeters: number,
  newDurationSeconds: number,
): FarePreviewSnapshot {
  const breakdown = estimatePayload.breakdown as FareBreakdown | undefined;
  const fareBreakdownJson = breakdown
    ? {
        baseFare: breakdown.base_fare,
        tripFare: breakdown.trip_fare,
        distanceCost: breakdown.distance_cost,
        timeCost: breakdown.time_cost,
        bookingFee: breakdown.booking_fee,
        airportCharge: breakdown.airport_charge,
        airportChargeSource: breakdown.airport_charge_source,
        airportPickupFee: breakdown.airport_pickup_fee || 0,
        airportDropoffFee: breakdown.airport_dropoff_fee || 0,
        fareDetails: breakdown.fare_details,
        surcharge: breakdown.surcharge,
        zoneApplied: breakdown.zone_applied,
        pickupZone: breakdown.pickup_zone,
        dropoffZone: breakdown.dropoff_zone,
        pickupZoneId: breakdown.pickup_zone_id,
        dropoffZoneId: breakdown.dropoff_zone_id,
        fixedFareApplied: breakdown.fixed_fare_applied,
        fareSource: breakdown.fare_source,
        pricing_mode: breakdown.pricing_mode,
        tripPricingMode: breakdown.pricing_mode,
        routeMatch: breakdown.route_match,
        matchedRouteId: breakdown.matched_route_id,
        totalFare: breakdown.final_fare,
      }
    : undefined;

  return {
    new_fare_pence: newFarePence,
    new_distance_meters: newDistanceMeters,
    new_duration_seconds: newDurationSeconds,
    fare_breakdown: breakdown,
    fare_breakdown_json: breakdown
      ? fareBreakdownToTripSnapshot(breakdown, {
          pickupZoneId: breakdown.pickup_zone_id,
          dropoffZoneId: breakdown.dropoff_zone_id,
        })
      : fareBreakdownJson,
    pricing_mode:
      (estimatePayload.tripPricingMode as string | undefined) ??
      (estimatePayload.pricingMode as string | undefined) ??
      breakdown?.pricing_mode ??
      null,
    base_fare_pence: breakdown
      ? negotiationBaseFarePenceFromBreakdown(breakdown)
      : null,
    polyline:
      typeof routePayload.polyline === "string" ? routePayload.polyline : null,
  };
}

/** Upsert route polyline after modification (trip_route_cache). */
export async function upsertTripRoutePolyline(
  supabase: SupabaseClient,
  tripId: string,
  polyline: string | null | undefined,
  trip: Record<string, unknown>,
): Promise<void> {
  if (!polyline) return;

  const originLat = Number(trip.pickup_latitude ?? 0);
  const originLng = Number(trip.pickup_longitude ?? 0);
  const destLat = Number(trip.dropoff_latitude ?? 0);
  const destLng = Number(trip.dropoff_longitude ?? 0);
  const distanceKm = Number(trip.estimated_distance_km ?? 0);
  const durationMin = Number(trip.estimated_duration_minutes ?? 0);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const { data: existing } = await supabase
    .from("trip_route_cache")
    .select("id")
    .eq("trip_id", tripId)
    .eq("leg", "full")
    .maybeSingle();

  const row = {
    trip_id: tripId,
    leg: "full",
    origin_lat: originLat,
    origin_lng: originLng,
    dest_lat: destLat,
    dest_lng: destLng,
    distance_km: distanceKm,
    duration_min: durationMin,
    polyline,
    cached_at: now,
    expires_at: expiresAt,
    updated_at: now,
    reroute_reason: "trip_modification",
  };

  if (existing?.id) {
    await supabase.from("trip_route_cache").update(row).eq("id", existing.id);
  } else {
    await supabase.from("trip_route_cache").insert(row);
  }
}

/** Fetch trip + stops + open mod + route cache, broadcast trip_updated, return normalized payload. */
export async function fetchTripAndBroadcastUpdated(
  supabase: SupabaseClient,
  tripId: string,
  routePolyline?: string | null,
  options?: {
    /** Applied trip_change_requests.id — preferred over latest-applied lookup. */
    changeRequestId?: string | null;
  },
): Promise<{ trip: Record<string, unknown>; payload: ReturnType<typeof normalizeTripUpdatedPayload> } | null> {
  const { data: trip, error } = await supabase
    .from("trips")
    .select("*")
    .eq("id", tripId)
    .single();

  if (error || !trip) {
    console.error("[tripModificationApply] fetch trip failed:", error);
    return null;
  }

  const [stopsResult, openModResult, routeCacheResult] = await Promise.all([
    supabase
      .from("trip_stops")
      .select("*")
      .eq("trip_id", tripId)
      .order("stop_index", { ascending: true }),
    supabase
      .from("trip_change_requests")
      .select(
        "id, status, payment_status, navigation_impacted, requires_approval, fare_delta_pence, new_fare_pence",
      )
      .eq("trip_id", tripId)
      .in("status", ["payment_required", "payment_pending", "pending_driver_approval"])
      .order("created_at", { ascending: false })
      .limit(1),
    supabase
      .from("trip_route_cache")
      .select("polyline, updated_at, cached_at")
      .eq("trip_id", tripId)
      .eq("leg", "full")
      .maybeSingle(),
  ]);

  const tripStops = stopsResult.data ?? [];
  const openMod = openModResult.data?.[0] ?? null;
  const routeCacheRow = routeCacheResult.data ?? null;
  const polyline =
    routePolyline
    ?? (typeof routeCacheRow?.polyline === "string" ? routeCacheRow.polyline : null);

  const driverApprovalStatus = openMod
    ? (openMod.status === "pending_driver_approval" ? "pending" : "not_required")
    : null;

  const payload = normalizeTripUpdatedPayload(trip as Record<string, unknown>, {
    routePolyline: polyline,
    stops: tripStops,
    paymentConfirmationStatus: openMod?.payment_status ?? null,
    driverApprovalStatus,
    openModificationRequestId: openMod?.id ?? null,
    routeCacheVersion: routeCacheRow?.updated_at ?? routeCacheRow?.cached_at ?? null,
    fareDeltaPence: openMod?.fare_delta_pence
      ?? (trip as { modification_delta_pence?: number | null }).modification_delta_pence
      ?? null,
    modificationStatus: openMod?.status
      ?? (trip as { modification_status?: string | null }).modification_status
      ?? null,
  });

  await broadcastTripUpdated(supabase, payload);

  // Heads-up / OS push when Realtime is missed (background, brief disconnect).
  // Awaited (not void) so the Edge isolate cannot freeze before FCM enqueue.
  // Failures are swallowed — committed modification must not roll back.
  const driverId =
    (typeof (trip as { confirmed_driver_id?: unknown }).confirmed_driver_id === "string"
      ? (trip as { confirmed_driver_id: string }).confirmed_driver_id
      : null) ||
    (typeof (trip as { driver_id?: unknown }).driver_id === "string"
      ? (trip as { driver_id: string }).driver_id
      : null);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (driverId && supabaseUrl && serviceKey) {
    const version =
      (typeof (trip as { trip_version?: unknown }).trip_version === "number"
        ? (trip as { trip_version: number }).trip_version
        : null) ??
      (typeof (trip as { updated_at?: unknown }).updated_at === "string"
        ? (trip as { updated_at: string }).updated_at
        : null) ??
      Date.now();

    // Prefer caller-supplied applied change-request id (exact mod identity).
    let changeRequestId =
      typeof options?.changeRequestId === "string" && options.changeRequestId.trim().length > 0
        ? options.changeRequestId.trim()
        : null;
    if (!changeRequestId) {
      try {
        const { data: appliedRow } = await supabase
          .from("trip_change_requests")
          .select("id")
          .eq("trip_id", tripId)
          .in("status", ["applied", "approved"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (typeof appliedRow?.id === "string" && appliedRow.id) {
          changeRequestId = appliedRow.id;
        }
      } catch (e) {
        console.warn("[tripModificationApply] applied change_request lookup failed:", e);
      }
    }

    // One applied modification → one notify attempt (replay-safe).
    // Key on detail.change_request_id (offer_id is ride_offers FK only).
    if (changeRequestId) {
      try {
        const { data: prior } = await supabase
          .from("booking_delivery_log")
          .select("id")
          .eq("booking_id", tripId)
          .eq("driver_id", driverId)
          .in("phase", [
            "push_enqueued",
            "push_sent",
            "push_enqueued_skip_no_token",
          ])
          .filter("detail->>change_request_id", "eq", changeRequestId)
          .limit(1)
          .maybeSingle();
        if (prior?.id) {
          console.log("[tripModificationApply] skip duplicate trip_modified notify", {
            trip_id: tripId,
            change_request_id: changeRequestId,
          });
          return {
            trip: { ...(trip as Record<string, unknown>), trip_stops: tripStops },
            payload,
          };
        }
      } catch (e) {
        console.warn("[tripModificationApply] duplicate-notify check failed (continuing):", e);
      }
    }

    try {
      await notifyDriverTripModified(supabaseUrl, serviceKey, driverId, {
        tripId,
        modificationVersion: version,
        changeRequestId,
        title: "Trip updated",
        body: "Customer changed the trip.",
      });
    } catch (e) {
      console.warn("[tripModificationApply] notifyDriverTripModified failed (mod intact):", e);
    }
  }

  return {
    trip: { ...(trip as Record<string, unknown>), trip_stops: tripStops },
    payload,
  };
}

/** Increment card preauth when modification increases gross fare (service-role safe). */
export async function invokePreauthUpdateOnModification(
  supabase: SupabaseClient,
  tripId: string,
  newEstimatedTotalPence: number,
): Promise<Record<string, unknown> | null> {
  if (!Number.isFinite(newEstimatedTotalPence) || newEstimatedTotalPence <= 0) {
    return { success: false, skipped: true, error: "Invalid payable total for preauth update" };
  }

  console.log("TRIP_MODIFICATION_PREAUTH_REQUEST", {
    tripId,
    newEstimatedTotalPence,
  });

  const { data, error } = await supabase.functions.invoke(
    "update-preauth-on-trip-modification",
    {
      body: {
        trip_id: tripId,
        tripId,
        new_estimated_total_pence: newEstimatedTotalPence,
        newEstimatedTotalPence,
      },
    },
  );

  if (error) {
    const contextBody = (error as { context?: { json?: () => Promise<Record<string, unknown>> } })
      ?.context;
    if (contextBody && typeof contextBody.json === "function") {
      try {
        const parsed = await contextBody.json();
        if (parsed?.requires_revolut_checkout === true) {
          console.log("TRIP_MODIFICATION_PREAUTH_REVOLUT_CHECKOUT", { tripId, parsed });
          return parsed;
        }
      } catch {
        // fall through
      }
    }
    console.error("TRIP_MODIFICATION_PREAUTH_FAILED", { tripId, error: error.message });
    throw error;
  }

  console.log("TRIP_MODIFICATION_PREAUTH_RESULT", { tripId, data });
  return (data ?? null) as Record<string, unknown> | null;
}
