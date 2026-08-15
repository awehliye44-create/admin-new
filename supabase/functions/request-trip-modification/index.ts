import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  buildFarePreviewSnapshot,
  fetchTripAndBroadcastUpdated,
  upsertTripRoutePolyline,
} from "../_shared/tripModificationApply.ts";
import { resolveModifyTripCurrentStops } from "../_shared/modifyTripStopsSSOT.ts";
import {
  computeLiveTripFarePreview,
  resolveConfirmedCustomerFarePence,
} from "../_shared/liveTripFareSSOT.ts";
import {
  currencySymbolForCode,
  metersToDisplayDistance,
} from "../_shared/units.ts";
import { computeRequiresDriverApproval } from "../_shared/tripModificationApproval.ts";
import { serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";

const LOCKED_STOP_STATUSES = new Set(["completed", "skipped", "arrived"]);
const PRE_PICKUP_STATUSES = new Set([
  "accepted",
  "confirmed",
  "driver_assigned",
  "en_route",
  "en_route_to_pickup",
  "enroute_to_pickup",
  "driver_en_route",
  "driver_arriving",
  "arrived",
  "arrived_pickup",
  "arrived_at_pickup",
  "at_pickup",
  "pickup_waiting",
  "waiting",
]);
const OPEN_MOD_STATUSES = [
  "payment_required",
  "payment_pending",
  "pending_driver_approval",
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Stop {
  address: string;
  lat: number;
  lng: number;
  type?: string;
  stop_index?: number;
  status?: string;
}

interface ModificationRequest {
  tripId: string;
  changeType: "add_stop" | "remove_stop" | "reorder_stops" | "change_dropoff";
  newStops?: Stop[];
  newDropoff?: {
    address: string;
    lat: number;
    lng: number;
    placeId?: string;
  };
  stopIndexToRemove?: number;
  previewOnly?: boolean;
}

function sortStops(stops: Stop[]): Stop[] {
  return [...stops].sort((a, b) => (a.stop_index ?? 0) - (b.stop_index ?? 0));
}

function isStopLocked(stop: Stop): boolean {
  return LOCKED_STOP_STATUSES.has(String(stop.status ?? "").toLowerCase());
}

/** Current navigation target: pickup before trip start, else first unlocked non-pickup stop/dropoff. */
function getCurrentNavStop(stops: Stop[], tripStatus: string): Stop | null {
  const sorted = sortStops(stops);
  if (PRE_PICKUP_STATUSES.has(tripStatus)) {
    return sorted.find((s) => s.type === "pickup") ?? sorted[0] ?? null;
  }
  return (
    sorted.find((s) => s.type !== "pickup" && !isStopLocked(s))
    ?? sorted.find((s) => s.type === "dropoff")
    ?? null
  );
}

function sameStopIdentity(a: Stop | null, b: Stop | null): boolean {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if ((a.stop_index ?? -1) !== (b.stop_index ?? -1)) return false;
  if (String(a.address ?? "") !== String(b.address ?? "")) return false;
  const latDiff = Math.abs(Number(a.lat ?? 0) - Number(b.lat ?? 0));
  const lngDiff = Math.abs(Number(a.lng ?? 0) - Number(b.lng ?? 0));
  return latDiff < 1e-5 && lngDiff < 1e-5;
}

function assertPastStopsImmutable(
  beforeStops: Stop[],
  afterStops: Stop[],
): string | null {
  const lockedBefore = sortStops(beforeStops).filter(isStopLocked);
  for (const locked of lockedBefore) {
    const match = afterStops.find((s) =>
      s.type === locked.type
      && (s.stop_index === locked.stop_index
        || (s.address === locked.address && s.type === locked.type))
    );
    if (!match) {
      return "Cannot modify completed or past stops";
    }
    if (
      String(match.address ?? "") !== String(locked.address ?? "")
      || Math.abs(Number(match.lat ?? 0) - Number(locked.lat ?? 0)) > 1e-5
      || Math.abs(Number(match.lng ?? 0) - Number(locked.lng ?? 0)) > 1e-5
    ) {
      return "Cannot modify completed or past stops";
    }
  }
  return null;
}

function hasValidCoords(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    !(lat === 0 && lng === 0)
  );
}

async function resolveCoordsFromAddress(
  supabaseUrl: string,
  serviceKey: string,
  address: string,
  serviceAreaId?: string | null,
): Promise<{ lat: number; lng: number } | null> {
  const trimmed = address.trim();
  if (trimmed.length < 3) return null;
  console.log("MODIFY_TRIP_PREVIEW_GEOCODE", { address: trimmed.substring(0, 80), serviceAreaId: serviceAreaId ?? null });
  const response = await fetch(`${supabaseUrl}/functions/v1/place-lookup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      address: trimmed,
      countryCode: "gb",
      serviceAreaId: serviceAreaId ?? undefined,
      resultTypes: ["address", "poi", "street", "place", "locality"],
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    console.warn("MODIFY_TRIP_PREVIEW_GEOCODE_FAILED", { status: response.status });
    return null;
  }
  if (hasValidCoords(payload.lat, payload.lng)) {
    return { lat: Number(payload.lat), lng: Number(payload.lng) };
  }
  return null;
}

async function ensureStopCoords(
  stop: Stop,
  supabaseUrl: string,
  serviceKey: string,
  serviceAreaId?: string | null,
): Promise<Stop> {
  if (hasValidCoords(stop.lat, stop.lng)) return stop;
  const resolved = await resolveCoordsFromAddress(supabaseUrl, serviceKey, stop.address, serviceAreaId);
  if (!resolved) return stop;
  return { ...stop, lat: resolved.lat, lng: resolved.lng };
}

type FareEstimatePayload = Record<string, unknown> & {
  success?: boolean;
  totalFarePence?: number;
  priceNum?: number;
  currencyCode?: string;
  distanceUnit?: string;
};

async function invokeEdgeFunctionJson(
  supabaseUrl: string,
  serviceKey: string,
  functionName: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; payload: FareEstimatePayload | null }> {
  const response = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as FareEstimatePayload | null;
  return { ok: response.ok, status: response.status, payload };
}

function normalizeCalculateFarePayload(
  payload: FareEstimatePayload,
  vehicleTypeId: string,
): FareEstimatePayload | null {
  const vehicleFares = payload.vehicleFares as Array<Record<string, unknown>> | undefined;
  const vehicleFare = vehicleFares?.find((row) => row.vehicleTypeId === vehicleTypeId) ?? vehicleFares?.[0];
  if (!vehicleFare) return null;

  const fare = vehicleFare.fare as Record<string, unknown> | undefined;
  const breakdown = (vehicleFare.breakdown ?? fare?.breakdown) as Record<string, unknown> | undefined;
  const totalFarePence = Number(
    fare?.totalFarePence ?? breakdown?.final_fare_pence ?? 0,
  );
  if (!Number.isFinite(totalFarePence) || totalFarePence <= 0) return null;

  return {
    success: true,
    totalFarePence,
    priceNum: Number(fare?.totalFare ?? breakdown?.final_fare ?? totalFarePence / 100),
    currencyCode: payload.currencyCode as string | undefined,
    distanceUnit: payload.distanceUnit as string | undefined,
    breakdown,
    tripPricingMode: fare?.tripPricingMode ?? breakdown?.pricing_mode,
    pricingMode: fare?.pricingMode ?? breakdown?.pricing_mode,
    ...fare,
  };
}

async function fetchModificationFareEstimate(
  supabaseUrl: string,
  serviceKey: string,
  params: {
    service_area_id: string;
    vehicle_type_id: string;
    estimated_distance_km: number;
    estimated_duration_min: number;
    pickup_lat?: number;
    pickup_lng?: number;
    dropoff_lat?: number;
    dropoff_lng?: number;
    stops?: Array<{ lat: number; lng: number }>;
  },
): Promise<FareEstimatePayload | null> {
  const fareBody = {
    service_area_id: params.service_area_id,
    vehicle_type_id: params.vehicle_type_id,
    estimated_distance_km: params.estimated_distance_km,
    estimated_duration_min: params.estimated_duration_min,
    pickup_lat: params.pickup_lat,
    pickup_lng: params.pickup_lng,
    dropoff_lat: params.dropoff_lat,
    dropoff_lng: params.dropoff_lng,
    ...(params.stops && params.stops.length > 0 ? { stops: params.stops } : {}),
  };

  const calculateResult = await invokeEdgeFunctionJson(
    supabaseUrl,
    serviceKey,
    "calculate-fare",
    fareBody,
  );
  if (calculateResult.payload?.success) {
    const normalized = normalizeCalculateFarePayload(
      calculateResult.payload,
      params.vehicle_type_id,
    );
    if (normalized) {
      console.log("MODIFY_TRIP_PREVIEW_FARE_SOURCE", { source: "calculate-fare" });
      return normalized;
    }
  }

  const estimateResult = await invokeEdgeFunctionJson(
    supabaseUrl,
    serviceKey,
    "estimate-fare",
    fareBody,
  );
  if (estimateResult.ok && estimateResult.payload?.success) {
    console.log("MODIFY_TRIP_PREVIEW_FARE_SOURCE", { source: "estimate-fare" });
    return estimateResult.payload;
  }

  console.error("MODIFY_TRIP_PREVIEW_FARE_FAILED", {
    calculateStatus: calculateResult.status,
    calculateSuccess: calculateResult.payload?.success ?? false,
    estimateStatus: estimateResult.status,
    estimateSuccess: estimateResult.payload?.success ?? false,
    estimateError: estimateResult.payload?.error ?? estimateResult.payload?.message ?? null,
  });
  return null;
}

function normalizeSnapshotStops(trip: any): Stop[] {
  const resolved = resolveModifyTripCurrentStops({
    tripStopsRows: trip.trip_stops ?? [],
    tripStopsJson: trip.stops,
  });

  const sortedStops = sortStops(resolved as Stop[]);
  const hasPickup = sortedStops.some((stop) => stop.type === "pickup");
  const hasDropoff = sortedStops.some((stop) => stop.type === "dropoff");
  const nextStopIndex = sortedStops.length > 0
    ? Math.max(...sortedStops.map((stop) => stop.stop_index ?? 0)) + 1
    : 0;

  return sortStops([
    ...(hasPickup ? [] : [{
      stop_index: 0,
      address: trip.pickup_address,
      lat: trip.pickup_latitude,
      lng: trip.pickup_longitude,
      type: "pickup",
      status: "pending",
    }]),
    ...sortedStops,
    ...(hasDropoff ? [] : [{
      stop_index: nextStopIndex,
      address: trip.dropoff_address,
      lat: trip.dropoff_latitude,
      lng: trip.dropoff_longitude,
      type: "dropoff",
      status: "pending",
    }]),
  ]);
}

function buildPreviewPayload(
  changeType: ModificationRequest["changeType"],
  afterRouteSnapshot: Record<string, unknown>,
  newFarePence: number,
  fareDeltaPence: number,
  newDistanceMeters: number,
  newDurationSeconds: number,
  locale: {
    currency: string;
    currencySymbol: string;
    distanceUnit: string;
    currentFare: number;
    newFare: number;
    fareIncrease: number;
    updatedDistance: number;
    updatedDurationMinutes: number;
  },
) {
  return {
    changeType,
    newFarePence,
    fareDeltaPence,
    newDistanceMeters,
    newDurationSeconds,
    currency: locale.currency,
    currencySymbol: locale.currencySymbol,
    distanceUnit: locale.distanceUnit,
    currentFare: locale.currentFare,
    newFare: locale.newFare,
    fareIncrease: locale.fareIncrease,
    updatedDistance: locale.updatedDistance,
    updatedDurationMinutes: locale.updatedDurationMinutes,
    routeSummary: {
      updatedDistance: locale.updatedDistance,
      distanceUnit: locale.distanceUnit,
      durationMinutes: locale.updatedDurationMinutes,
    },
    afterRouteSnapshot,
  };
}

serveWithEdgeTiming("request-trip-modification", corsHeaders, async (req) => {

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      console.error("Auth error:", userError);
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body: ModificationRequest = await req.json();
    const { tripId, changeType, newStops, newDropoff, stopIndexToRemove, previewOnly = false } = body;

    console.log("Trip modification request:", { tripId, changeType, userId: user.id, previewOnly });

    if (!tripId || !changeType) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (changeType === "add_stop" && (!newStops || newStops.length === 0)) {
      return new Response(JSON.stringify({ error: "newStops required for add_stop" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (changeType === "change_dropoff" && !newDropoff) {
      return new Response(JSON.stringify({ error: "newDropoff required for change_dropoff" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (changeType === "remove_stop" && stopIndexToRemove === undefined) {
      return new Response(JSON.stringify({ error: "stopIndexToRemove required for remove_stop" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: trip, error: tripError } = await supabase
      .from("trips")
      .select(`
        *,
        trip_stops!trip_stops_trip_id_fkey (*)
      `)
      .eq("id", tripId)
      .single();

    if (tripError || !trip) {
      console.error("MODIFY_TRIP_PREVIEW_FAILED_REASON", {
        reason: "trip_lookup_failed",
        tripId,
        code: tripError?.code ?? null,
        message: tripError?.message ?? null,
        details: tripError?.details ?? null,
      });
      return new Response(JSON.stringify({ error: "Trip not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: customer } = await supabase
      .from("customers")
      .select("id, user_id")
      .eq("user_id", user.id)
      .single();

    if (!customer || trip.passenger_id !== customer.id) {
      return new Response(JSON.stringify({ error: "Not authorized to modify this trip" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const allowedStatuses = [
      "accepted",
      "confirmed",
      "driver_assigned",
      "en_route",
      "en_route_to_pickup",
      "enroute_to_pickup",
      "driver_en_route",
      "driver_arriving",
      "arrived",
      "arrived_pickup",
      "arrived_at_pickup",
      "at_pickup",
      "pickup_waiting",
      "waiting",
      "in_progress",
      "started",
      "ongoing",
      "at_stop",
      "driving_to_next_stop",
    ];
    // Queued stacked assignment — block all fare-affecting edits until promotion.
    if (trip.status === "queued") {
      return new Response(JSON.stringify({
        error: "Trip cannot be modified",
        reason: "STACKED_TRIP_MODIFICATION_BLOCKED",
        code: "STACKED_TRIP_MODIFICATION_BLOCKED",
        message: "Trip modifications are unavailable while your driver finishes another trip.",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!allowedStatuses.includes(trip.status)) {
      return new Response(JSON.stringify({
        error: "Trip cannot be modified",
        reason: `Current status '${trip.status}' does not allow modifications`,
        allowedStatuses,
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: existingRequests } = await supabase
      .from("trip_change_requests")
      .select("id, status, created_at")
      .eq("trip_id", tripId)
      .in("status", OPEN_MOD_STATUSES)
      .limit(1);

    const existingRequest = existingRequests?.[0] ?? null;
    if (existingRequest) {
      return new Response(JSON.stringify({
        error: "Pending modification request exists",
        message: existingRequest.status === "payment_required" || existingRequest.status === "payment_pending"
          ? "Please complete payment confirmation for the current modification request"
          : "Please wait for driver to respond to current modification request",
        existingRequestId: existingRequest.id,
        existingStatus: existingRequest.status,
      }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const currentStops = normalizeSnapshotStops(trip);
    const liveFare = computeLiveTripFarePreview({
      final_customer_fare_pence: trip.final_customer_fare_pence ?? null,
      final_fare_pence: trip.final_fare_pence ?? null,
      locked_base_fare_pence: trip.locked_base_fare_pence ?? null,
      pickup_waiting_charge_pence: trip.pickup_waiting_charge_pence ?? null,
      stop_waiting_charge_pence: trip.stop_waiting_charge_pence ?? null,
      stop_charge_total_pence: trip.stop_charge_total_pence ?? null,
      customer_modification_charge_pence: trip.customer_modification_charge_pence ?? null,
      modification_delta_pence: trip.modification_delta_pence ?? null,
      driver_tier_commission_percent: trip.driver_tier_commission_percent ?? null,
      commission_pct: trip.commission_pct ?? null,
      commission_pence: trip.commission_pence ?? null,
      gross_fare_pence: trip.gross_fare_pence ?? null,
    });
    const currentConfirmedCustomerTotalPence = liveFare.current_customer_total_pence;
    const currentConfirmedFarePence = resolveConfirmedCustomerFarePence({
      final_customer_fare_pence: trip.final_customer_fare_pence ?? null,
      final_fare_pence: trip.final_fare_pence ?? null,
      locked_base_fare_pence: trip.locked_base_fare_pence ?? null,
    }) || (
      trip.estimated_total_pence != null && Number(trip.estimated_total_pence) > 0
        ? Number(trip.estimated_total_pence)
        : Math.round(Number(trip.estimated_fare ?? trip.fare ?? 0) * 100)
    ) || 0;

    console.log("TRIP_MODIFICATION_REQUEST", {
      tripId,
      changeType,
      userId: user.id,
      previewOnly,
      currentConfirmedFarePence,
      currentConfirmedCustomerTotalPence,
    });

    const beforeRouteSnapshot = {
      pickup: {
        address: trip.pickup_address,
        lat: trip.pickup_latitude,
        lng: trip.pickup_longitude,
      },
      dropoff: {
        address: trip.dropoff_address,
        lat: trip.dropoff_latitude,
        lng: trip.dropoff_longitude,
      },
      stops: currentStops,
      estimated_distance_km: trip.estimated_distance_km,
      estimated_duration_minutes: trip.estimated_duration_minutes,
      estimated_fare: trip.fare ?? trip.estimated_fare,
    };

    const afterRouteSnapshot = JSON.parse(JSON.stringify(beforeRouteSnapshot));

    if (changeType === "add_stop") {
      const maxIndex = afterRouteSnapshot.stops.reduce(
        (max: number, stop: Stop) => Math.max(max, stop.stop_index ?? 0),
        -1,
      );

      const resolvedStops = await Promise.all(
        newStops!.map((stop) =>
          ensureStopCoords(stop, supabaseUrl, supabaseServiceKey, trip.service_area_id),
        ),
      );
      const invalidStop = resolvedStops.find((stop) => !hasValidCoords(stop.lat, stop.lng));
      if (invalidStop) {
        return new Response(JSON.stringify({
          success: false,
          error: "Unable to resolve stop address. Please select a suggestion and try again.",
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const stopsToAdd = resolvedStops.map((stop, index) => ({
        address: stop.address,
        lat: stop.lat,
        lng: stop.lng,
        type: "stop",
        status: "pending",
        stop_index: maxIndex + index + 1,
      }));

      afterRouteSnapshot.stops = sortStops([...afterRouteSnapshot.stops, ...stopsToAdd]);
    } else if (changeType === "remove_stop") {
      const stopToRemove = afterRouteSnapshot.stops.find((stop: Stop) => stop.stop_index === stopIndexToRemove);
      if (!stopToRemove || stopToRemove.type !== "stop") {
        return new Response(JSON.stringify({ error: "Stop not found" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (isStopLocked(stopToRemove)) {
        return new Response(JSON.stringify({ error: "Cannot remove completed or past stop" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Customer modifications apply authoritatively — Driver approval is not required.
      // Allow removing the active navigation target; Driver gets a heads-up after apply.
      const navStop = getCurrentNavStop(afterRouteSnapshot.stops, trip.status);
      if (
        navStop
        && trip.status === "in_progress"
        && (stopToRemove.stop_index ?? 0) < (navStop.stop_index ?? 0)
        && !sameStopIdentity(navStop, stopToRemove)
      ) {
        return new Response(JSON.stringify({ error: "Cannot remove past stop" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      afterRouteSnapshot.stops = afterRouteSnapshot.stops.filter(
        (stop: Stop) => stop.stop_index !== stopIndexToRemove,
      );
    } else if (changeType === "reorder_stops") {
      if (!newStops || newStops.length === 0) {
        return new Response(JSON.stringify({ error: "newStops required for reorder" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const pickupStop = afterRouteSnapshot.stops.find((stop: Stop) => stop.type === "pickup") ?? {
        address: beforeRouteSnapshot.pickup.address,
        lat: beforeRouteSnapshot.pickup.lat,
        lng: beforeRouteSnapshot.pickup.lng,
        type: "pickup",
        status: "pending",
        stop_index: 0,
      };

      const dropoffStop = afterRouteSnapshot.stops.find((stop: Stop) => stop.type === "dropoff") ?? {
        address: afterRouteSnapshot.dropoff.address,
        lat: afterRouteSnapshot.dropoff.lat,
        lng: afterRouteSnapshot.dropoff.lng,
        type: "dropoff",
        status: "pending",
        stop_index: newStops.length + 1,
      };

      afterRouteSnapshot.stops = [
        { ...pickupStop, stop_index: 0 },
        ...newStops.map((stop, index) => ({
          address: stop.address,
          lat: stop.lat,
          lng: stop.lng,
          type: stop.type || "stop",
          status: "pending",
          stop_index: index + 1,
        })),
        {
          ...dropoffStop,
          address: afterRouteSnapshot.dropoff.address,
          lat: afterRouteSnapshot.dropoff.lat,
          lng: afterRouteSnapshot.dropoff.lng,
          type: "dropoff",
          stop_index: newStops.length + 1,
        },
      ];
    } else if (changeType === "change_dropoff") {
      const resolvedDropoff = await ensureStopCoords(
        {
          address: newDropoff!.address,
          lat: newDropoff!.lat,
          lng: newDropoff!.lng,
        },
        supabaseUrl,
        supabaseServiceKey,
        trip.service_area_id,
      );
      if (!hasValidCoords(resolvedDropoff.lat, resolvedDropoff.lng)) {
        return new Response(JSON.stringify({
          success: false,
          error: "Unable to resolve dropoff address. Please select a suggestion and try again.",
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      afterRouteSnapshot.dropoff = {
        address: resolvedDropoff.address,
        lat: resolvedDropoff.lat,
        lng: resolvedDropoff.lng,
      };

      const existingDropoffIndex = afterRouteSnapshot.stops.findIndex((stop: Stop) => stop.type === "dropoff");
      const fallbackStopIndex = afterRouteSnapshot.stops.reduce(
        (max: number, stop: Stop) => Math.max(max, stop.stop_index ?? 0),
        -1,
      ) + 1;

      const updatedDropoffStop: Stop = {
        address: resolvedDropoff.address,
        lat: resolvedDropoff.lat,
        lng: resolvedDropoff.lng,
        type: "dropoff",
        status: "pending",
        stop_index: existingDropoffIndex >= 0
          ? afterRouteSnapshot.stops[existingDropoffIndex].stop_index
          : fallbackStopIndex,
      };

      if (existingDropoffIndex >= 0) {
        afterRouteSnapshot.stops[existingDropoffIndex] = updatedDropoffStop;
      } else {
        afterRouteSnapshot.stops.push(updatedDropoffStop);
      }

      afterRouteSnapshot.stops = sortStops(afterRouteSnapshot.stops);
    }

    const pastLockError = assertPastStopsImmutable(currentStops, afterRouteSnapshot.stops);
    if (pastLockError) {
      return new Response(JSON.stringify({ error: pastLockError }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const navBeforeRemove = getCurrentNavStop(currentStops, String(trip.status ?? ""));
    const originLat = PRE_PICKUP_STATUSES.has(String(trip.status ?? "").toLowerCase())
      ? trip.pickup_latitude
      : (
        trip.driver_location_lat
        ?? navBeforeRemove?.lat
        ?? trip.pickup_latitude
      );
    const originLng = PRE_PICKUP_STATUSES.has(String(trip.status ?? "").toLowerCase())
      ? trip.pickup_longitude
      : (
        trip.driver_location_lng
        ?? navBeforeRemove?.lng
        ?? trip.pickup_longitude
      );
    const destinationLat = afterRouteSnapshot.dropoff?.lat;
    const destinationLng = afterRouteSnapshot.dropoff?.lng;
    const beforeDestinationLat = beforeRouteSnapshot.dropoff?.lat;
    const beforeDestinationLng = beforeRouteSnapshot.dropoff?.lng;

    if (originLat == null || originLng == null || destinationLat == null || destinationLng == null) {
      return new Response(JSON.stringify({ error: "Unable to recalculate fare. Please try again." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const remainingStopsForRoute = (stops: Stop[]) =>
      sortStops(stops)
        .filter((stop) => stop.type === "stop" && !isStopLocked(stop))
        .map((stop) => ({ lat: stop.lat, lng: stop.lng }));

    const intermediateStops = remainingStopsForRoute(afterRouteSnapshot.stops);
    const beforeIntermediateStops = remainingStopsForRoute(beforeRouteSnapshot.stops);

    async function calculateRouteLeg(
      destLat: number,
      destLng: number,
      intermediates: Array<{ lat: number; lng: number }>,
    ) {
      const routeResponse = await fetch(`${supabaseUrl}/functions/v1/calculate-route`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: supabaseServiceKey,
          Authorization: `Bearer ${supabaseServiceKey}`,
        },
        body: JSON.stringify({
          originLat,
          originLng,
          destLat,
          destLng,
          intermediateStops: intermediates,
        }),
      });
      const routePayload = await routeResponse.json().catch(() => null);
      if (!routeResponse.ok || !routePayload?.success) return null;
      const distance = Number(routePayload.distanceMeters ?? Math.round((routePayload.distanceKm ?? 0) * 1000));
      const duration = Number(routePayload.durationSeconds ?? Math.round((routePayload.durationMinutes ?? 0) * 60));
      // Allow 0m remaining (e.g. dropoff ≈ current position after removing last via).
      if (!Number.isFinite(distance) || distance < 0 || !Number.isFinite(duration) || duration < 0) {
        return null;
      }
      return {
        routePayload,
        distance,
        duration: duration > 0 ? duration : 1,
      };
    }

    const [afterRoute, beforeRoute] = await Promise.all([
      calculateRouteLeg(destinationLat, destinationLng, intermediateStops),
      beforeDestinationLat != null && beforeDestinationLng != null
        ? calculateRouteLeg(beforeDestinationLat, beforeDestinationLng, beforeIntermediateStops)
        : Promise.resolve(null),
    ]);

    if (!afterRoute) {
      console.error("Route preview failed for after snapshot");
      return new Response(JSON.stringify({
        success: false,
        error: "Unable to recalculate fare. Please try again.",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const routePayload = afterRoute.routePayload;
    const newDistance = afterRoute.distance;
    const newDuration = afterRoute.duration;

    let resolvedVehicleTypeId = trip.vehicle_type_id;
    if (!resolvedVehicleTypeId && trip.vehicle_type) {
      const { data: vehicleTypeRow } = await supabase
        .from("vehicle_types")
        .select("id")
        .eq("slug", trip.vehicle_type)
        .limit(1)
        .maybeSingle();

      resolvedVehicleTypeId = vehicleTypeRow?.id ?? null;
    }

    if (!trip.service_area_id || !resolvedVehicleTypeId) {
      return new Response(JSON.stringify({
        success: false,
        error: "Unable to recalculate fare. Please try again.",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const estimatePayload = await fetchModificationFareEstimate(
      supabaseUrl,
      supabaseServiceKey,
      {
        service_area_id: trip.service_area_id,
        vehicle_type_id: resolvedVehicleTypeId,
        estimated_distance_km: newDistance / 1000,
        estimated_duration_min: newDuration / 60,
        pickup_lat: originLat,
        pickup_lng: originLng,
        dropoff_lat: destinationLat,
        dropoff_lng: destinationLng,
        stops: intermediateStops,
      },
    );

    if (!estimatePayload?.success) {
      return new Response(JSON.stringify({
        success: false,
        error: "Unable to recalculate fare. Please try again.",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const newRemainingRouteFarePence = Number(
      estimatePayload.totalFarePence ?? Math.round((estimatePayload.priceNum ?? 0) * 100),
    );

    if (!Number.isFinite(newRemainingRouteFarePence) || newRemainingRouteFarePence <= 0) {
      return new Response(JSON.stringify({
        success: false,
        error: "Unable to recalculate fare. Please try again.",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Remaining-route delta SSOT (preview === apply):
    // fare_delta = new_remaining_route_fare - old_remaining_route_fare
    // new_customer_total = current_confirmed_customer_total + fare_delta
    let oldRemainingRouteFarePence = currentConfirmedFarePence;
    if (beforeRoute) {
      const beforeEstimate = await fetchModificationFareEstimate(
        supabaseUrl,
        supabaseServiceKey,
        {
          service_area_id: trip.service_area_id,
          vehicle_type_id: resolvedVehicleTypeId,
          estimated_distance_km: beforeRoute.distance / 1000,
          estimated_duration_min: beforeRoute.duration / 60,
          pickup_lat: originLat,
          pickup_lng: originLng,
          dropoff_lat: beforeDestinationLat!,
          dropoff_lng: beforeDestinationLng!,
          stops: beforeIntermediateStops,
        },
      );
      if (beforeEstimate?.success) {
        const beforePence = Number(
          beforeEstimate.totalFarePence ?? Math.round((beforeEstimate.priceNum ?? 0) * 100),
        );
        if (Number.isFinite(beforePence) && beforePence > 0) {
          oldRemainingRouteFarePence = beforePence;
        }
      }
    }

    const remainingRouteDeltaPence = newRemainingRouteFarePence - oldRemainingRouteFarePence;
    const fareDeltaPence = remainingRouteDeltaPence;
    const newCustomerTotalPence = currentConfirmedCustomerTotalPence + fareDeltaPence;
    // Persist payable trip total (confirmed fare + delta); waiting remains live-only.
    const newFarePence = Math.max(1, currentConfirmedFarePence + fareDeltaPence);

    const beforeDistanceMeters = beforeRoute?.distance != null
      ? Math.round(Number(beforeRoute.distance))
      : (trip.estimated_distance_km != null
        ? Math.round(Number(trip.estimated_distance_km) * 1000)
        : null);
    const beforeDurationSeconds = beforeRoute?.duration != null
      ? Math.round(Number(beforeRoute.duration))
      : (trip.estimated_duration_minutes != null
        ? Math.round(Number(trip.estimated_duration_minutes) * 60)
        : null);

    // Requires driver approval when route/fare/workload changes materially (MK-260704-002).
    const navigationImpacted = computeRequiresDriverApproval({
      changeType,
      beforeStops: currentStops,
      afterStops: afterRouteSnapshot.stops,
      tripStatus: String(trip.status ?? ""),
      fareDeltaPence,
      beforeDistanceMeters,
      afterDistanceMeters: newDistance,
      beforeDurationSeconds,
      afterDurationSeconds: newDuration,
    });

    const currencyCode = String(estimatePayload.currencyCode || trip.currency_code || "").toUpperCase();
    const distanceUnit = String(estimatePayload.distanceUnit || trip.distance_unit || "km");
    if (!currencyCode) {
      return new Response(JSON.stringify({
        success: false,
        error: "Unable to recalculate fare. Please try again.",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const currencySymbol = currencySymbolForCode(currencyCode);
    const updatedDurationMinutes = Math.ceil(newDuration / 60);
    const updatedDistance = Math.round(metersToDisplayDistance(newDistance, distanceUnit) * 100) / 100;
    const currentFare = Math.round(currentConfirmedCustomerTotalPence) / 100;
    const newFare = Math.round(newCustomerTotalPence) / 100;
    const fareIncrease = Math.round(fareDeltaPence) / 100;

    afterRouteSnapshot.estimated_distance_km = Math.round((newDistance / 1000) * 100) / 100;
    afterRouteSnapshot.estimated_duration_minutes = updatedDurationMinutes;
    afterRouteSnapshot.estimated_fare = newFare;
    afterRouteSnapshot.navigation_impacted = navigationImpacted;
    afterRouteSnapshot.fare_preview = {
      ...buildFarePreviewSnapshot(
        estimatePayload as Record<string, unknown>,
        routePayload as Record<string, unknown>,
        newFarePence,
        newDistance,
        newDuration,
      ),
      current_confirmed_customer_total_pence: currentConfirmedCustomerTotalPence,
      new_customer_total_pence: newCustomerTotalPence,
      remaining_route_delta_pence: remainingRouteDeltaPence,
      old_remaining_route_fare_pence: oldRemainingRouteFarePence,
      new_remaining_route_fare_pence: newRemainingRouteFarePence,
      navigation_impacted: navigationImpacted,
    };

    const preview = buildPreviewPayload(
      changeType,
      afterRouteSnapshot,
      newFarePence,
      fareDeltaPence,
      newDistance,
      newDuration,
      {
        currency: currencyCode,
        currencySymbol,
        distanceUnit,
        currentFare,
        newFare,
        fareIncrease,
        updatedDistance,
        updatedDurationMinutes,
      },
    );

    if (previewOnly) {
      return new Response(JSON.stringify({
        success: true,
        previewOnly: true,
        preview,
        newFare: newCustomerTotalPence / 100,
        fareDelta: fareDeltaPence / 100,
        fareDeltaPence,
        newFarePence,
        newCustomerTotalPence,
        currentConfirmedCustomerTotalPence,
        paymentRequired: fareDeltaPence > 0,
        navigationImpacted,
        requiresApproval: navigationImpacted,
        newDistanceMeters: newDistance,
        newDurationSeconds: newDuration,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const expiresAt = new Date(Date.now() + 120000).toISOString();
    const paymentRequired = fareDeltaPence > 0;

    const { data: changeRequest, error: insertError } = await supabase
      .from("trip_change_requests")
      .insert({
        trip_id: tripId,
        requested_by: "customer",
        requester_id: user.id,
        change_type: changeType,
        before_route_snapshot: beforeRouteSnapshot,
        after_route_snapshot: afterRouteSnapshot,
        original_fare_pence: currentConfirmedFarePence > 0 ? currentConfirmedFarePence : null,
        new_fare_pence: newFarePence,
        fare_delta_pence: fareDeltaPence,
        original_distance_meters: trip.estimated_distance_km ? Math.round(Number(trip.estimated_distance_km) * 1000) : null,
        new_distance_meters: newDistance,
        original_duration_seconds: trip.estimated_duration_minutes ? Math.round(Number(trip.estimated_duration_minutes) * 60) : null,
        new_duration_seconds: newDuration,
        expires_at: expiresAt,
        navigation_impacted: navigationImpacted,
        requires_approval: navigationImpacted,
        payment_status: paymentRequired ? "required" : "not_required",
        // Trigger determine_trip_change_approval sets final status from payment + nav rules.
        status: paymentRequired
          ? "payment_required"
          : navigationImpacted
            ? "pending_driver_approval"
            : "approved",
      })
      .select()
      .single();

    if (insertError) {
      console.error("Failed to create modification request:", insertError);
      return new Response(JSON.stringify({
        error: "Failed to create modification request",
        details: insertError.message,
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Re-read after triggers (status may be applied).
    const { data: latestRequest } = await supabase
      .from("trip_change_requests")
      .select("*")
      .eq("id", changeRequest.id)
      .single();

    const finalRequest = latestRequest ?? changeRequest;

    console.log("Modification request created:", finalRequest.id, {
      status: finalRequest.status,
      requiresApproval: finalRequest.requires_approval,
      navigationImpacted: finalRequest.navigation_impacted,
      paymentStatus: finalRequest.payment_status,
      fareDeltaPence,
      changeType,
    });

    // Auto-applied (no payment, no nav impact): broadcast trip_updated.
    if (finalRequest.status === "applied" || finalRequest.status === "approved") {
      const polyline =
        typeof afterRouteSnapshot.fare_preview === "object" &&
          afterRouteSnapshot.fare_preview != null &&
          typeof (afterRouteSnapshot.fare_preview as Record<string, unknown>).polyline === "string"
          ? (afterRouteSnapshot.fare_preview as Record<string, unknown>).polyline as string
          : null;
      try {
        const result = await fetchTripAndBroadcastUpdated(supabase, tripId, polyline);
        if (result?.trip) {
          await upsertTripRoutePolyline(supabase, tripId, polyline, result.trip);
        }
      } catch (broadcastErr) {
        console.error("[request-trip-modification] auto-apply broadcast failed:", broadcastErr);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      requestId: finalRequest.id,
      status: finalRequest.status ?? "pending_driver_approval",
      requiresApproval: finalRequest.requires_approval ?? navigationImpacted,
      navigationImpacted: finalRequest.navigation_impacted ?? navigationImpacted,
      paymentStatus: finalRequest.payment_status ?? (paymentRequired ? "required" : "not_required"),
      paymentRequired,
      expiresAt,
      preview,
      fareDelta: fareDeltaPence / 100,
      fareDeltaPence,
      newFare: newCustomerTotalPence / 100,
      newFarePence,
      newCustomerTotalPence,
      currentConfirmedCustomerTotalPence,
      newDistanceMeters: newDistance,
      newDurationSeconds: newDuration,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Trip modification request error:", error);
    return new Response(JSON.stringify({
      error: "Internal server error",
      details: error instanceof Error ? error.message : "Unknown error",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
