import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { resolveCustomerPreauthBasePence } from "../_shared/customerDisplayFare.ts";
import { buildServiceAreaConfigPayload } from "../_shared/serviceAreaConfigSSOT.ts";
import { buildTripCommunicationConfigForTrip } from "../_shared/tripCommunicationConfigBuilder.ts";
import { computeLiveTripFarePreview } from "../_shared/liveTripFareSSOT.ts";
import { getCurrencySymbol } from "../../../shared/currency.ts";
import { serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";
import { releaseHoldOnTripTerminal } from "../_shared/holdReleaseSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** Keep in sync with customer app PUBLISH_STATUSES + useCustomerLiveLocationPublisher. */
/** Live customer phases — excludes `queued` (stacked ride waiting on Trip A). */
const CUSTOMER_LIVE_PRE_PICKUP_STATES = [
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
] as const;

const SCHEDULED_LIVE_STATES = [
  ...CUSTOMER_LIVE_PRE_PICKUP_STATES,
  "in_progress",
  "completing",
];

type TripRow = Record<string, any>;

function parseTimeMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isScheduledTrip(row: TripRow): boolean {
  const bookingType = String(row.booking_type ?? row.trip_type ?? "").toLowerCase();
  if (bookingType === "instant" || bookingType === "immediate") return false;
  if (bookingType === "scheduled") return true;
  return row.is_scheduled === true;
}

function scheduledDispatchWindowReached(row: TripRow, nowMs: number): boolean {
  const dispatchMode = String(row.dispatch_mode ?? "").toLowerCase();
  if (dispatchMode === "instant") return true;

  return [
    row.scheduled_broadcast_at,
    row.scheduled_convert_at,
    row.scheduled_at,
  ].some((value) => {
    const ms = parseTimeMs(value);
    return ms !== null && ms <= nowMs;
  });
}

const TERMINAL_TRIP_STATUSES = new Set([
  "completed",
  "cancelled",
  "canceled",
  "customer_cancelled",
  "customer_canceled",
  "expired",
  "expired_no_driver",
  "no_show",
  "failed",
]);

const SEARCHING_TRIP_STATUSES = new Set([
  "pending",
  "searching",
  "offered",
  "offering",
  "broadcasting",
  "searching_new_driver",
  "driver_cancelled",
]);

const ACTIVE_REMATCH_DISPATCH = new Set([
  "broadcasting",
  "searching",
  "offering",
  "offered",
]);

const ASSIGNED_DISPATCH = new Set([
  "assigned",
  "accepted",
  "confirmed",
  "en_route",
  "enroute",
  "arriving",
  "arrived",
  "in_progress",
  "started",
]);

function isDriverAssignedDespiteCancelledStatus(row: TripRow): boolean {
  if (row.cancelled_by !== "driver") return false;
  if (row.cancel_reason !== "driver_cancelled") return false;
  const confirmed = row.confirmed_driver_id;
  if (!(typeof confirmed === "string" && confirmed.trim().length > 0)) return false;
  const dispatch = String(row.dispatch_status ?? "").trim().toLowerCase();
  return ASSIGNED_DISPATCH.has(dispatch);
}

function isActiveDriverCancelRematchDespiteStatus(row: TripRow, nowMs: number): boolean {
  if (row.cancelled_by !== "driver") return false;
  if (row.cancel_reason !== "driver_cancelled") return false;
  const confirmed = row.confirmed_driver_id;
  if (typeof confirmed === "string" && confirmed.trim().length > 0) return false;
  const driver = row.driver_id;
  if (typeof driver === "string" && driver.trim().length > 0) return false;
  const dispatch = String(row.dispatch_status ?? "").trim().toLowerCase();
  if (!ACTIVE_REMATCH_DISPATCH.has(dispatch)) return false;
  if (!row.searching_expires_at) return false;
  const deadlineMs = new Date(row.searching_expires_at).getTime();
  return Number.isFinite(deadlineMs) && nowMs < deadlineMs;
}

function isSearchWindowExpiredForCustomer(row: TripRow, nowMs: number): boolean {
  const status = String(row.status ?? "").toLowerCase();
  if (!SEARCHING_TRIP_STATUSES.has(status)) return false;
  if (row.driver_id || row.confirmed_driver_id) return false;

  const expiresRaw = (row as { searching_expires_at?: string | null }).searching_expires_at;
  if (expiresRaw) {
    const expiresMs = new Date(expiresRaw).getTime();
    return Number.isFinite(expiresMs) && nowMs >= expiresMs;
  }

  if (status === "searching_new_driver" || status === "driver_cancelled") {
    return true;
  }

  return false;
}

function isCustomerLiveTrip(row: TripRow, nowMs: number): boolean {
  const status = String(row.status ?? "").toLowerCase();
  if (!status) return false;

  if (TERMINAL_TRIP_STATUSES.has(status)) {
    if (isActiveDriverCancelRematchDespiteStatus(row, nowMs)) return true;
    if (isDriverAssignedDespiteCancelledStatus(row)) return true;
    return false;
  }

  if (SEARCHING_TRIP_STATUSES.has(status)) {
    if (isSearchWindowExpiredForCustomer(row, nowMs)) return false;
  }

  if (!isScheduledTrip(row)) return true;

  const hasDriver = Boolean(row.driver_id || row.confirmed_driver_id);
  return (
    hasDriver &&
    SCHEDULED_LIVE_STATES.includes(status) &&
    scheduledDispatchWindowReached(row, nowMs)
  );
}

serveWithEdgeTiming("get-active-trip", corsHeaders, async (req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create client with user's auth header for token verification
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // Verify the JWT token using getUser (reliable across all Supabase versions)
    const { data: userData, error: userError } = await supabaseAuth.auth.getUser();
    
    if (userError || !userData?.user) {
      console.error("Auth error:", userError);
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = userData.user.id;
    console.log("Checking active trip for user:", userId);

    // Create service client for database operations
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get customer record with active_trip_id
    const { data: customers, error: customerError } = await supabase
      .from("customers")
      .select("id, active_trip_id")
      .eq("user_id", userId);

    if (customerError) {
      console.error("Failed to fetch customer:", customerError);
      return new Response(
        JSON.stringify({ activeTrip: null }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const customer = customers?.[0];

    // Get the active trip details - only if it's in an active state
    const activeStates = [
      "payment_pending",
      "pending",
      "searching",
      "offered",
      "offering",
      "broadcasting",
      "negotiating",
      "driver_cancelled",
      "searching_new_driver",
      "queued",
      ...CUSTOMER_LIVE_PRE_PICKUP_STATES,
      "in_progress",
      "completing",
      "scheduled",
    ];

    const nowMs = Date.now();
    let trip: TripRow | null = null;

    // Primary: check active_trip_id on customer record
    if (customer?.active_trip_id) {
      const { data: trips, error: tripError } = await supabase
        .from("trips")
        .select("*")
        .eq("id", customer.active_trip_id);

      if (!tripError && trips?.[0]) {
        const candidate = trips[0] as TripRow;
        if (isCustomerLiveTrip(candidate, nowMs)) {
          trip = candidate;
        } else if (isSearchWindowExpiredForCustomer(candidate, nowMs)) {
          console.log("STALE_SEARCHING_TRIP_FOUND", {
            trip_id: candidate.id,
            status: candidate.status,
            searching_expires_at: candidate.searching_expires_at ?? null,
          });
          const { data: expiredByServer, error: expireErr } = await supabase.rpc(
            "expire_trip_when_search_exhausted",
            { p_trip_id: candidate.id },
          );
          if (expireErr) {
            console.warn("SEARCH_CYCLE_EXPIRED_BACKEND expire RPC failed:", candidate.id, expireErr);
          } else if (expiredByServer === true) {
            console.log("TRIP_MARKED_EXPIRED_NO_DRIVER", { trip_id: candidate.id });
            console.log("CUSTOMER_EXPIRED_FROM_BACKEND", { trip_id: candidate.id });
            try {
              const holdRelease = await releaseHoldOnTripTerminal(supabase, {
                tripId: candidate.id,
                terminalReason: "no_driver_search_exhausted",
                source: "get-active-trip",
                idempotencyKey: `get_active_trip_expire_${candidate.id}`,
                forceRelease: true,
              });
              console.log("HOLD_RELEASE_AFTER_EXPIRE", { trip_id: candidate.id, ...holdRelease });
            } catch (holdErr) {
              console.error("HOLD_RELEASE_AFTER_EXPIRE failed (non-fatal):", candidate.id, holdErr);
            }
          }
          await supabase
            .from("customers")
            .update({ active_trip_id: null })
            .eq("user_id", userId);
        } else {
          console.log("Trip is not live for customer yet:", candidate.id, "status:", candidate.status, "scheduled:", candidate.is_scheduled);
          if (TERMINAL_TRIP_STATUSES.has(String(candidate.status ?? "").toLowerCase())) {
            await supabase
              .from("customers")
              .update({ active_trip_id: null })
              .eq("user_id", userId);
          }
        }
      } else {
        // Trip exists but is not in active state - clear the reference
        console.log("Trip not in active state, clearing reference");
        await supabase
          .from("customers")
          .update({ active_trip_id: null })
          .eq("user_id", userId);
      }
    }

    // Fallback: check for any active trip that may not have active_trip_id set yet
    // passenger_id in trips = customer.id, not auth user_id
    // IMPORTANT: For scheduled trips (is_scheduled=true), only return as "active"
    // if a driver has been assigned (driver_id IS NOT NULL). Pre-assignment states
    // like searching/broadcasting/offering should remain in the UpcomingTrips UI,
    // not hijack the main active-trip detection.
    if (!trip && customer) {
      // First try: non-scheduled instant trips in any active state
      const { data: instantTrips } = await supabase
        .from("trips")
        .select("*")
        .eq("passenger_id", customer.id)
        .in("status", activeStates)
        .or("is_scheduled.is.null,is_scheduled.eq.false")
        .order("created_at", { ascending: false })
        .limit(1);

      // Second try: scheduled trips only once dispatch has started and a driver
      // is in a customer-live state. Early pre-confirmation stays upcoming.
      let scheduledTrip = null;
      if (!instantTrips?.[0]) {
        const { data: scheduledCandidates } = await supabase
          .from("trips")
          .select("*")
          .eq("passenger_id", customer.id)
          .eq("is_scheduled", true)
          .in("status", SCHEDULED_LIVE_STATES)
          .order("created_at", { ascending: false })
          .limit(10);
        scheduledTrip = (scheduledCandidates ?? []).find((candidate) =>
          isCustomerLiveTrip(candidate as TripRow, nowMs)
        ) || null;
      }

      const activatedTrips = instantTrips?.[0] ? instantTrips : (scheduledTrip ? [scheduledTrip] : null);

      if (activatedTrips?.[0]) {
        trip = activatedTrips[0];
        // Backfill active_trip_id for future lookups
        await supabase
          .from("customers")
          .update({ active_trip_id: trip.id })
          .eq("user_id", userId);
        console.log("Backfilled active_trip_id for trip:", trip.id);
      }
    }

    if (!trip) {
      console.log("No active trip for user");
      return new Response(
        JSON.stringify({ activeTrip: null }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Found active trip:", trip.id, "status:", trip.status);

    const { data: tripStopsRows } = await supabase
      .from("trip_stops")
      .select(
        "id, stop_index, type, address, status, arrived_at, lat, lng, waiting_charge_active, waiting_started_at, waiting_stopped_at, waiting_total_amount_pence",
      )
      .eq("trip_id", trip.id)
      .order("stop_index", { ascending: true });

    const { data: openModRequests } = await supabase
      .from("trip_change_requests")
      .select(
        "id, status, payment_status, navigation_impacted, requires_approval, fare_delta_pence, new_fare_pence",
      )
      .eq("trip_id", trip.id)
      .in("status", ["payment_required", "payment_pending", "pending_driver_approval"])
      .order("created_at", { ascending: false })
      .limit(1);

    const openMod = openModRequests?.[0] ?? null;
    const lockedPastStopIds = (tripStopsRows ?? [])
      .filter((s) => ["completed", "skipped", "arrived"].includes(String(s.status ?? "").toLowerCase()))
      .map((s) => s.id);
    const currentActiveStopSequence = (tripStopsRows ?? []).find((s) =>
      !["completed", "skipped", "arrived"].includes(String(s.status ?? "").toLowerCase())
      && s.type !== "pickup"
    )?.stop_index
      ?? (tripStopsRows ?? []).find((s) =>
        !["completed", "skipped", "arrived"].includes(String(s.status ?? "").toLowerCase())
      )?.stop_index
      ?? trip.current_stop_index
      ?? null;
    const editableFutureStopIds = (tripStopsRows ?? [])
      .filter((s) => {
        const status = String(s.status ?? "").toLowerCase();
        if (["completed", "skipped", "arrived"].includes(status)) return false;
        if (s.type === "pickup") return false;
        if (currentActiveStopSequence != null && (s.stop_index ?? 0) < currentActiveStopSequence) {
          return false;
        }
        return true;
      })
      .map((s) => s.id);

    const { data: routeCacheRow } = await supabase
      .from("trip_route_cache")
      .select("polyline, updated_at, cached_at")
      .eq("trip_id", trip.id)
      .eq("leg", "full")
      .maybeSingle();

    // Get driver info only if driver has accepted (confirmed_driver_id)
    // For instant trips, driver_id is set at acceptance. For scheduled, confirmed_driver_id is the authority.
    const resolvedDriverId = trip.confirmed_driver_id || trip.driver_id;
    let driver = null;
    if (resolvedDriverId) {
      // Parallel: fetch driver row + approved profile photo document
      const [driverResult, profilePhotoResult] = await Promise.all([
        supabase
          .from("drivers")
          .select("id,first_name,last_name,phone,profile_photo_url,rating,current_lat,current_lng")
          .eq("id", resolvedDriverId)
          .maybeSingle(),
        supabase
          .from("documents")
          .select("file_url")
          .eq("driver_id", resolvedDriverId)
          .eq("document_type", "profile_photo")
          .eq("status", "approved")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      driver = driverResult.data || null;

      // Generate a signed URL for the profile photo using service role
      if (driver) {
        const rawUrl = profilePhotoResult.data?.file_url || driver.profile_photo_url;
        if (rawUrl) {
          // Extract storage path from Supabase URL
          const bucketName = "driver-documents";
          try {
            const parsed = new URL(rawUrl);
            const publicPrefix = `/storage/v1/object/public/${bucketName}/`;
            const signedPrefix = `/storage/v1/object/sign/${bucketName}/`;
            let storagePath: string | null = null;
            if (parsed.pathname.includes(publicPrefix)) {
              storagePath = decodeURIComponent(parsed.pathname.split(publicPrefix)[1] ?? "");
            } else if (parsed.pathname.includes(signedPrefix)) {
              storagePath = decodeURIComponent(parsed.pathname.split(signedPrefix)[1] ?? "");
            }
            if (storagePath) {
              const { data: signedData } = await supabase.storage
                .from(bucketName)
                .createSignedUrl(storagePath, 3600); // 1 hour
              if (signedData?.signedUrl) {
                driver.profile_photo_url = signedData.signedUrl;
                console.log("Generated signed profile photo URL for driver:", resolvedDriverId);
              }
            }
          } catch (e) {
            console.warn("Failed to generate signed photo URL:", e);
          }
        }
      }
    }

    const displayFarePence = resolveCustomerPreauthBasePence(trip);
    const displayFareMajor = displayFarePence / 100;
    const liveFarePreview = computeLiveTripFarePreview({
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
    console.log("TRIP_HYDRATION_FARE_SOURCE", {
      tripId: trip.id,
      displayFarePence,
      grossFarePence: trip.gross_fare_pence ?? null,
      finalFarePence: trip.final_fare_pence ?? null,
      fareLocked: trip.fare_locked ?? false,
    });

    const serviceAreaId = trip.service_area_id ?? null;
    let regionConfig: Awaited<ReturnType<typeof buildServiceAreaConfigPayload>> | null = null;
    if (serviceAreaId) {
      const built = await buildServiceAreaConfigPayload(supabase, serviceAreaId);
      if (!("error" in built)) {
        regionConfig = built;
      }
    }

    const tripCurrencyCode = trip.currency_code
      ? String(trip.currency_code).toUpperCase()
      : regionConfig && !("error" in regionConfig)
        ? regionConfig.currency_code
        : null;
    const tripDistanceUnit = trip.distance_unit
      ?? (regionConfig && !("error" in regionConfig) ? regionConfig.distance_unit : null);
    const tripCurrencySymbol = regionConfig && !("error" in regionConfig)
      ? regionConfig.currency_symbol
      : tripCurrencyCode
        ? (() => {
            const sym = getCurrencySymbol(tripCurrencyCode);
            return sym === "—" ? null : sym;
          })()
        : null;

    const communicationConfig = await buildTripCommunicationConfigForTrip(supabase, {
      id: trip.id,
      status: trip.status,
      service_area_id: serviceAreaId,
      driver_id: trip.driver_id ?? null,
      confirmed_driver_id: trip.confirmed_driver_id ?? null,
      passenger_id: trip.passenger_id ?? null,
    });

    return new Response(
      JSON.stringify({
        activeTrip: {
          id: trip.id,
          tripCode: trip.trip_code,
          status: trip.status,
          passengerId: trip.passenger_id ?? null,
          pickupAddress: trip.pickup_address,
          dropoffAddress: trip.dropoff_address,
          pickupLat: trip.pickup_latitude,
          pickupLng: trip.pickup_longitude,
          dropoffLat: trip.dropoff_latitude,
          dropoffLng: trip.dropoff_longitude,
          estimatedFare: displayFareMajor,
          fare: trip.fare ?? displayFareMajor,
          totalFare: displayFareMajor,
          baseFare: trip.base_fare_pence != null ? trip.base_fare_pence / 100 : null,
          finalFarePence: trip.final_fare_pence ?? displayFarePence,
          finalCustomerFarePence: trip.final_customer_fare_pence ?? displayFarePence,
          grossFarePence: trip.gross_fare_pence ?? null,
          estimatedTotalPence: displayFarePence,
          lockedBaseFarePence: trip.locked_base_fare_pence ?? null,
          offerDiscountPence: trip.offer_discount_pence ?? trip.discount_pence ?? null,
          fareLocked: trip.fare_locked ?? false,
          fareSnapshotJson: trip.fare_snapshot_json ?? null,
          currencyCode: tripCurrencyCode,
          currency_code: tripCurrencyCode,
          currency_symbol: tripCurrencySymbol,
          serviceAreaId,
          service_area_id: serviceAreaId,
          vehicleTypeId: trip.vehicle_type_id ?? null,
          regionId: trip.region_id ?? regionConfig?.region_id ?? null,
          region_id: trip.region_id ?? regionConfig?.region_id ?? null,
          distance_unit: tripDistanceUnit,
          distanceUnit: tripDistanceUnit,
          payment_provider: regionConfig && !("error" in regionConfig)
            ? regionConfig.payment_provider
            : null,
          customer_payment_gateway: regionConfig && !("error" in regionConfig)
            ? regionConfig.customer_payment_gateway
            : null,
          driver_payout_gateway: regionConfig && !("error" in regionConfig)
            ? regionConfig.driver_payout_gateway
            : null,
          enabled_payment_methods: regionConfig && !("error" in regionConfig)
            ? regionConfig.enabled_payment_methods
            : null,
          gateway_status: regionConfig && !("error" in regionConfig)
            ? regionConfig.gateway_status
            : null,
          paymentGateways: regionConfig && !("error" in regionConfig)
            ? regionConfig.paymentGateways
            : null,
          fareBreakdown: trip.fare_breakdown ?? null,
          pricingMode: trip.pricing_mode ?? null,
          distance: trip.estimated_distance_km ?? null,
          duration: trip.estimated_duration_minutes ?? null,
          updatedAt: trip.updated_at ?? null,
          driverId: trip.driver_id,
          driver,
          createdAt: trip.created_at,
          scheduledAt: trip.scheduled_at,
          scheduledStatus: trip.scheduled_status,
          scheduledBroadcastAt: trip.scheduled_broadcast_at,
          scheduledConvertAt: trip.scheduled_convert_at,
          isScheduled: trip.is_scheduled,
          dispatchMode: trip.dispatch_mode,
          searchingExpiresAt: trip.searching_expires_at ?? null,
          cancelledDriverIds: trip.cancelled_driver_ids ?? null,
          cancelledBy: trip.cancelled_by ?? null,
          cancelReason: trip.cancel_reason ?? null,
          dispatchStatus: trip.dispatch_status ?? null,
          currentBroadcastRound: trip.current_broadcast_round ?? null,
          arrivedAt: trip.arrived_at ?? null,
          pickupWaitingStartedAt: trip.pickup_waiting_started_at ?? null,
          pickupPaidWaitingStartedAt: trip.pickup_paid_waiting_started_at ?? null,
          gracePeriodExpiredAt: trip.grace_period_expired_at ?? null,
          freeWaitExpiresAt: trip.free_wait_expires_at ?? null,
          pickupWaitingFreeExpiresAt: trip.free_wait_expires_at ?? null,
          pickupWaitingAdminConfig: trip.pickup_waiting_admin_config ?? null,
          adminWaitingConfigSnapshot: trip.pickup_waiting_admin_config ?? null,
          pickupWaitingChargePence: trip.pickup_waiting_charge_pence ?? null,
          finalCustomerFarePence: liveFarePreview.final_customer_fare_pence,
          stopWaitingChargePence: liveFarePreview.stop_waiting_charge_pence,
          approvedModificationDeltaPence: liveFarePreview.approved_modification_delta_pence,
          currentCustomerTotalPence: liveFarePreview.current_customer_total_pence,
          driverNetPreviewPence: liveFarePreview.driver_net_preview_pence,
          commissionPercent: liveFarePreview.commission_percent,
          fareDeltaPence: openMod?.fare_delta_pence ?? trip.modification_delta_pence ?? null,
          modificationStatus: openMod?.status ?? trip.modification_status ?? null,
          paymentConfirmationStatus: openMod?.payment_status ?? null,
          driverApprovalStatus: openMod
            ? (openMod.status === "pending_driver_approval"
              ? "pending"
              : openMod.navigation_impacted
                ? "not_required"
                : "not_required")
            : null,
          navigationImpacted: openMod?.navigation_impacted ?? null,
          openModificationRequestId: openMod?.id ?? null,
          currentActiveStopSequence,
          lockedPastStopIds,
          editableFutureStopIds,
          routePolyline: routeCacheRow?.polyline ?? null,
          routeCacheVersion: routeCacheRow?.updated_at ?? routeCacheRow?.cached_at ?? null,
          currentStopIndex: trip.current_stop_index ?? null,
          stopArrivedAt: trip.stop_arrived_at ?? null,
          stopWaitingStartedAt: trip.stop_waiting_started_at ?? null,
          stopWaitingStatus: trip.stop_waiting_status ?? null,
          stopWaitingPaidStartedAt: trip.stop_waiting_paid_started_at ?? null,
          stopChargeTotalPence: trip.stop_charge_total_pence ?? null,
          tripStops: (tripStopsRows ?? []).map((stop) => ({
            id: stop.id,
            stop_index: stop.stop_index,
            type: stop.type,
            address: stop.address,
            status: stop.status,
            arrived_at: stop.arrived_at,
            lat: stop.lat,
            lng: stop.lng,
            waiting_charge_active: stop.waiting_charge_active,
            waiting_started_at: stop.waiting_started_at,
            waiting_stopped_at: stop.waiting_stopped_at,
            waiting_total_amount_pence: stop.waiting_total_amount_pence,
          })),
          communicationConfig,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Get active trip error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
