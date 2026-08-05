import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { resolveCustomerPreauthBasePence } from "../_shared/customerDisplayFare.ts";
import { computeLiveTripFarePreview } from "../_shared/liveTripFareSSOT.ts";
import {
  buildRestoreActiveTripPayload,
  buildRestoreNonePayload,
  findCustomerActiveTrip,
  findDriverActiveTrip,
  loadTripStops,
} from "../_shared/activeTripRestoreCore.ts";
import type { RestoreActiveTripRole } from "../../../shared/activeTripRestoreSSOT.ts";
import {
  handleCORSPreflight,
} from "../_shared/security.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version, x-onecab-native-client, baggage, sentry-trace",
};

async function buildCustomerActiveTrip(
  trip: Record<string, unknown>,
  driver: Record<string, unknown> | null,
  stops: Record<string, unknown>[],
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
    updated_at: trip.updated_at ?? null,
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
    currentBroadcastRound: trip.current_broadcast_round ?? null,
    arrivedAt: trip.arrived_at ?? trip.pickup_arrived_at ?? trip.driver_arrived_at ?? null,
    pickupArrivedAt: trip.pickup_arrived_at ?? trip.driver_arrived_at ?? null,
    driverArrivedAt: trip.driver_arrived_at ?? trip.pickup_arrived_at ?? null,
    pickupWaitingStartedAt: trip.pickup_waiting_started_at ?? null,
    pickupPaidWaitingStartedAt: trip.pickup_paid_waiting_started_at ?? null,
    freeWaitExpiresAt:
      trip.pickup_waiting_free_expires_at ?? trip.free_wait_expires_at ?? null,
    pickupWaitingFreeExpiresAt: trip.pickup_waiting_free_expires_at ?? null,
    freeWaitingSeconds:
      trip.free_waiting_seconds ?? trip.free_pickup_waiting_seconds ?? null,
    freePickupWaitingSeconds: trip.free_pickup_waiting_seconds ?? null,
    waitingSnapshot: trip.waiting_snapshot ?? null,
    waiting_snapshot: trip.waiting_snapshot ?? null,
    pickupWaitingAdminConfig:
      trip.pickup_waiting_admin_config ?? trip.admin_waiting_config_snapshot ?? null,
    pickup_waiting_admin_config:
      trip.pickup_waiting_admin_config ?? trip.admin_waiting_config_snapshot ?? null,
    adminWaitingConfigSnapshot: trip.admin_waiting_config_snapshot ?? null,
    noShowEligibleAt: trip.no_show_eligible_at ?? null,
    noShowEligible: trip.no_show_eligible ?? null,
    noShowRemainingSeconds: trip.no_show_remaining_seconds ?? null,
    gracePeriodExpiredAt: trip.grace_period_expired_at ?? null,
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
    stopChargeTotalPence: trip.stop_charge_total_pence ?? null,
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
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

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

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await supabaseAuth.auth.getUser();
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = userData.user.id;
    let body: { role?: RestoreActiveTripRole } = {};
    try {
      if (req.method === "POST") {
        const text = await req.text();
        if (text.trim()) body = JSON.parse(text);
      }
    } catch {
      /* empty body ok */
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    let role: RestoreActiveTripRole = body.role ?? "customer";

    if (!body.role) {
      const { data: driverRow } = await supabase
        .from("drivers")
        .select("id")
        .eq("user_id", userId)
        .maybeSingle();
      const { data: customerRow } = await supabase
        .from("customers")
        .select("id")
        .eq("user_id", userId)
        .maybeSingle();
      if (driverRow && !customerRow) role = "driver";
      else if (customerRow) role = "customer";
    }

    console.log("RESTORE_ACTIVE_TRIP_START", { userId, role });

    let trip: Record<string, unknown> | null = null;

    if (role === "driver") {
      const found = await findDriverActiveTrip(supabase, userId);
      trip = found.trip;
    } else {
      trip = await findCustomerActiveTrip(supabase, userId);
    }

    if (!trip?.id) {
      console.log("RESTORE_ACTIVE_TRIP_NONE", { userId, role });
      return new Response(JSON.stringify(buildRestoreNonePayload(role)), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tripId = String(trip.id);
    const stops = await loadTripStops(supabase, tripId);
    const payload = await buildRestoreActiveTripPayload(supabase, trip, role, stops);

    console.log("RESTORE_ACTIVE_TRIP_FOUND", {
      userId,
      role,
      trip_id: tripId,
      status: trip.status ?? null,
      lifecycle_action: payload.lifecycle_action ?? null,
    });

    const response: Record<string, unknown> = { ...payload };
    const enrichedTrip =
      (payload.trip as Record<string, unknown> | undefined) ?? trip;
    delete response.trip;

    if (role === "customer") {
      response.activeTrip = await buildCustomerActiveTrip(
        enrichedTrip,
        (payload.driver as Record<string, unknown> | null) ?? null,
        stops,
      );
    } else {
      // Driver hydrate reads waiting_snapshot / admin config from this row.
      response.trip_row = enrichedTrip;
      response.activeTrip = enrichedTrip;
    }

    return new Response(JSON.stringify(response), {
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
