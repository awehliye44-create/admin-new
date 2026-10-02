import type { AnySupabaseClient } from "../_shared/supabaseClientTypes.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { resolveCustomerPreauthBasePence } from "../_shared/customerDisplayFare.ts";
import { computeLiveTripFarePreview } from "../_shared/liveTripFareSSOT.ts";
import {
  buildRestoreActiveTripPayload,
  buildRestoreNonePayload,
  findCustomerActiveTripDetailed,
  findDriverActiveTrip,
  loadTripStops,
} from "../_shared/activeTripRestoreCore.ts";
import type { RestoreActiveTripRole } from "../_shared/activeTripRestoreSSOT.ts";
import { serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";
import { buildTripCommunicationConfigForTrip } from "../_shared/tripCommunicationConfigBuilder.ts";
import { loadCustomerNegotiationView } from "../_shared/customerNegotiationView.ts";
import {
  attachRestoreTiming,
  createRestoreEdgeTiming,
} from "../_shared/restoreEdgeTimingSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version, x-onecab-native-client, baggage, sentry-trace",
};

async function buildCustomerActiveTrip(
  supabase: AnySupabaseClient,
  trip: Record<string, unknown>,
  driver: Record<string, unknown> | null,
  stops: Record<string, unknown>[],
  communicationConfig?: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
  const displayFarePence = resolveCustomerPreauthBasePence(trip);
  const displayFareMajor = displayFarePence / 100;
  const liveFarePreview = computeLiveTripFarePreview({
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

  const resolvedCommunication =
    communicationConfig ??
    (await buildTripCommunicationConfigForTrip(supabase, {
      id: String(trip.id),
      status: String(trip.status ?? ""),
      service_area_id: (trip.service_area_id as string | null) ?? null,
      driver_id: (trip.driver_id as string | null) ?? null,
      confirmed_driver_id: (trip.confirmed_driver_id as string | null) ?? null,
      passenger_id: (trip.passenger_id as string | null) ?? null,
    }));

  return {
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
    finalFarePence: trip.final_fare_pence ?? displayFarePence,
    finalCustomerFarePence: liveFarePreview.final_customer_fare_pence,
    grossFarePence: trip.gross_fare_pence ?? null,
    estimatedTotalPence: displayFarePence,
    lockedBaseFarePence: trip.locked_base_fare_pence ?? null,
    offerDiscountPence: trip.offer_discount_pence ?? trip.discount_pence ?? null,
    fareLocked: trip.fare_locked ?? false,
    fareSnapshotJson: trip.fare_snapshot_json ?? null,
    currencyCode: trip.currency_code ?? null,
    serviceAreaId: trip.service_area_id ?? null,
    vehicleTypeId: trip.vehicle_type_id ?? null,
    regionId: trip.region_id ?? null,
    updatedAt: trip.updated_at ?? null,
    driverId: trip.driver_id ?? trip.confirmed_driver_id ?? null,
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
    negotiation_disabled: trip.negotiation_disabled === true,
    negotiation_locked_until: trip.negotiation_locked_until ?? null,
    currentBroadcastRound: trip.current_broadcast_round ?? null,
    arrivedAt: trip.arrived_at ?? null,
    pickupWaitingStartedAt: trip.pickup_waiting_started_at ?? null,
    pickupPaidWaitingStartedAt: trip.pickup_paid_waiting_started_at ?? null,
    gracePeriodExpiredAt: trip.grace_period_expired_at ?? null,
    freeWaitExpiresAt: trip.free_wait_expires_at ?? null,
    pickupWaitingFreeExpiresAt: trip.free_wait_expires_at ?? null,
    pickupWaitingAdminConfig:
      trip.admin_waiting_config_snapshot ?? trip.pickup_waiting_admin_config ?? null,
    adminWaitingConfigSnapshot:
      trip.admin_waiting_config_snapshot ?? trip.pickup_waiting_admin_config ?? null,
    pickupWaitingChargePence: trip.pickup_waiting_charge_pence ?? null,
    stopWaitingChargePence: liveFarePreview.stop_waiting_charge_pence,
    approvedModificationDeltaPence: liveFarePreview.approved_modification_delta_pence,
    currentCustomerTotalPence: liveFarePreview.current_customer_total_pence,
    driverNetPreviewPence: liveFarePreview.driver_net_preview_pence,
    commissionPercent: liveFarePreview.commission_percent,
    currentStopIndex: trip.current_stop_index ?? null,
    stopArrivedAt: trip.stop_arrived_at ?? null,
    stopWaitingStartedAt: trip.stop_waiting_started_at ?? null,
    stopWaitingStatus: trip.stop_waiting_status ?? null,
    stopWaitingPaidStartedAt: trip.stop_waiting_paid_started_at ?? null,
    stopWaitingFreeExpiresAt:
      trip.stop_waiting_free_expires_at ??
      (trip.waiting_snapshot as { stop_waiting_free_expires_at?: string | null } | null)
        ?.stop_waiting_free_expires_at ??
      null,
    freeStopWaitingSeconds: trip.free_stop_waiting_seconds ?? null,
    stopChargeTotalPence: trip.stop_charge_total_pence ?? null,
    /** trips.stops JSON (intermediates only) — fallback when trip_stops rows lag post-commit. */
    stops: Array.isArray(trip.stops) ? trip.stops : [],
    tripStops: stops.map((stop) => ({
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
    paymentConfirmationStatus: trip.payment_status ?? null,
    communicationConfig: resolvedCommunication,
  };
}

serveWithEdgeTiming("restore-active-trip", corsHeaders, async (req) => {
  const timing = createRestoreEdgeTiming();
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    timing.markAuthStart();
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await supabaseAuth.auth.getUser();
    timing.markAuthEnd();
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = userData.user.id;
    let body: {
      role?: RestoreActiveTripRole;
      trip_id?: string | null;
      tripId?: string | null;
      restore_trigger?: string | null;
      trigger?: string | null;
    } = {};
    try {
      if (req.method === "POST") {
        const text = await req.text();
        if (text.trim()) body = JSON.parse(text);
      }
    } catch {
      /* empty body ok */
    }

    const knownTripIdHint =
      (typeof body.trip_id === "string" && body.trip_id.trim()) ||
      (typeof body.tripId === "string" && body.tripId.trim()) ||
      null;
    timing.setKnownTripId(Boolean(knownTripIdHint));
    timing.setTrigger(
      (typeof body.restore_trigger === "string" && body.restore_trigger) ||
        (typeof body.trigger === "string" && body.trigger) ||
        null,
    );

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    let role: RestoreActiveTripRole = body.role ?? "customer";

    timing.markIdentityStart();
    // Customer app always sends role:"customer" — skip drivers∩customers probe.
    if (!body.role) {
      const [{ data: driverRow }, { data: customerRow }] = await Promise.all([
        supabase.from("drivers").select("id").eq("user_id", userId).maybeSingle(),
        supabase.from("customers").select("id").eq("user_id", userId).maybeSingle(),
      ]);
      if (driverRow && !customerRow) role = "driver";
      else if (customerRow) role = "customer";
    }
    timing.markIdentityEnd();

    console.log("RESTORE_ACTIVE_TRIP_START", {
      userId,
      role,
      known_trip_id: Boolean(knownTripIdHint),
    });

    let trip: Record<string, unknown> | null = null;
    let knownTripHit = false;

    timing.markTripStart();
    if (role === "driver") {
      const found = await findDriverActiveTrip(supabase, userId);
      trip = found.trip;
    } else {
      const found = await findCustomerActiveTripDetailed(supabase, userId, {
        knownTripId: knownTripIdHint,
      });
      trip = found.trip;
      knownTripHit = found.knownTripHit;
      timing.setKnownTripHit(found.knownTripIdPresent ? found.knownTripHit : null);
    }
    timing.markTripEnd();

    if (!trip?.id) {
      console.log("RESTORE_ACTIVE_TRIP_NONE", { userId, role });
      timing.markResponseStart();
      return new Response(
        JSON.stringify(attachRestoreTiming(buildRestoreNonePayload(role), timing)),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const tripId = String(trip.id);
    timing.markStopsStart();
    const stops = await loadTripStops(supabase, tripId);
    timing.markStopsEnd();

    const negotiating =
      role === "customer" && String(trip.status ?? "") === "negotiating";
    const originalFarePence =
      role === "customer" ? resolveCustomerPreauthBasePence(trip) : 0;

    timing.markEnrichStart();
    timing.markSecondaryStart();
    // Enrich (driver∥waiting) ∥ communication ∥ negotiation — independent after trip+stops.
    const [payload, communicationConfig, negotiation] = await Promise.all([
      buildRestoreActiveTripPayload(supabase, trip, role, stops, {
        onDriverMs: (ms) => timing.setDriverMs(ms),
        onWaitingMs: (ms) => timing.setWaitingMs(ms),
      }),
      buildTripCommunicationConfigForTrip(supabase, {
        id: tripId,
        status: String(trip.status ?? ""),
        service_area_id: (trip.service_area_id as string | null) ?? null,
        driver_id: (trip.driver_id as string | null) ?? null,
        confirmed_driver_id: (trip.confirmed_driver_id as string | null) ?? null,
        passenger_id: (trip.passenger_id as string | null) ?? null,
      }),
      negotiating
        ? loadCustomerNegotiationView(supabase, tripId, originalFarePence)
        : Promise.resolve(null),
    ]);
    timing.markEnrichEnd();
    timing.markSecondaryEnd();

    console.log("RESTORE_ACTIVE_TRIP_FOUND", {
      userId,
      role,
      trip_id: tripId,
      status: trip.status ?? null,
      lifecycle_action: payload.lifecycle_action ?? null,
      known_trip_hit: knownTripHit,
    });

    const response: Record<string, unknown> = { ...payload };
    const enrichedTrip =
      payload.trip && typeof payload.trip === "object"
        ? (payload.trip as Record<string, unknown>)
        : null;
    delete response.trip;

    if (role === "customer") {
      // Prefer enriched trip (waiting expiry + admin config) so intermediate-stop
      // waiting UI restores without requiring another Driver action.
      const tripForCustomer = {
        ...trip,
        ...(enrichedTrip ?? {}),
        admin_waiting_config_snapshot:
          payload.admin_waiting_config_snapshot ??
          trip.admin_waiting_config_snapshot ??
          trip.pickup_waiting_admin_config ??
          null,
      };

      timing.markResponseStart();
      response.activeTrip = await buildCustomerActiveTrip(
        supabase,
        tripForCustomer,
        negotiating ? null : ((payload.driver as Record<string, unknown> | null) ?? null),
        stops,
        communicationConfig as unknown as Record<string, unknown>,
      );
      // Always stamp the key. Omitting it lets Customer merge keep stale
      // waiting_customer / £Z chips after second chance, rematch, or assign.
      (response.activeTrip as Record<string, unknown>).negotiation = negotiation;
      if (negotiating) {
        (response.activeTrip as Record<string, unknown>).driver = null;
        (response.activeTrip as Record<string, unknown>).driverId = null;
      }
    } else {
      response.trip_row = trip;
      response.communicationConfig = communicationConfig;
      timing.markResponseStart();
    }

    return new Response(JSON.stringify(attachRestoreTiming(response, timing)), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("RESTORE_ACTIVE_TRIP_FAILED", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
