/**
 * P0 — Post-trip-commit background work. Must never block booking HTTP response.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  calculateFare,
  negotiationBaseFarePenceFromBreakdown,
  ZONE_ROUTE_PRICING_SELECT,
  type FarePricingRow,
  type ZoneRow,
  type ZoneRoutePricingRow,
  type LatLng,
} from "./pricing-engine.ts";
import {
  customerSearchExpiresAtIso,
  loadDispatchSettings,
  maxBroadcastRounds,
} from "./dispatch-settings.ts";
import { invokeAutoDispatch } from "./dispatchOrchestrator.ts";
import { applyBookingFareToTripData } from "./persist-booking-fare.ts";
import { resolveBestOfferForTrip } from "./resolve-offer.ts";
import { resolvePersonalVoucherForTrip } from "./resolve-personal-voucher.ts";
import {
  buildPreauthIdempotencyKey,
  recordPaymentAuthorizationEvent,
} from "./dynamicPaymentWorkflow.ts";
import { finalizeRevolutTokenCapture } from "./revolutSavedCardWalletLink.ts";
import { resolveRevolutMerchantContext } from "./revolutMerchantContext.ts";
import {
  markPaymentSessionDispatching,
} from "./paymentSessionSSOT.ts";
import type { BookingWaterfallCollector } from "./bookingWaterfallTelemetry.ts";
import type { BookingCommitBody } from "./bookingSSOT.ts";

export type TripStopRow = {
  trip_id: string;
  stop_index: number;
  type: "pickup" | "stop" | "dropoff";
  address: string;
  lat: number | null;
  lng: number | null;
  status: string;
};

export type BookingPostCommitContext = {
  supabase: SupabaseClient;
  userId: string;
  customerId: string;
  body: BookingCommitBody;
  tripId: string;
  paymentRefId: string;
  paymentProvider: "revolut";
  preauthAmountPence: number;
  grossFarePence: number;
  finalFarePence: number;
  paymentSessionId: string | null;
  serviceAreaId: string;
  regionId: string | null;
  regionCurrencyCode: string;
  regionDistanceUnit: string;
  isScheduled: boolean;
  preauthMetadata: Record<string, string>;
  bookingWaterfall: BookingWaterfallCollector;
  log: (step: string, details?: unknown) => void;
};

function buildTripStops(tripId: string, body: BookingCommitBody): TripStopRow[] {
  const intermediateStops = body.stops || [];
  const stops: TripStopRow[] = [{
    trip_id: tripId,
    stop_index: 0,
    type: "pickup",
    address: body.pickup.address,
    lat: body.pickup.lat || null,
    lng: body.pickup.lng || null,
    status: "current",
  }];
  intermediateStops.forEach((stop, i) => {
    stops.push({
      trip_id: tripId,
      stop_index: i + 1,
      type: "stop",
      address: stop.address,
      lat: stop.lat || null,
      lng: stop.lng || null,
      status: "pending",
    });
  });
  stops.push({
    trip_id: tripId,
    stop_index: intermediateStops.length + 1,
    type: "dropoff",
    address: body.dropoff.address,
    lat: body.dropoff.lat || null,
    lng: body.dropoff.lng || null,
    status: "pending",
  });
  return stops;
}

async function enrichTripFareAsync(ctx: BookingPostCommitContext): Promise<void> {
  const { body, supabase, tripId, log } = ctx;
  let appliedOfferId: string | null = null;
  let appliedDiscountPence = 0;
  let appliedPersonalVoucherId: string | null = null;
  let appliedPersonalVoucherCode: string | null = null;
  let voucherDiscountPence = 0;
  let discountSource: "personal_voucher" | "global_offer" | null = null;
  let finalFarePence = ctx.finalFarePence;
  let grossFarePence = ctx.grossFarePence;

  const personalVoucherCode = body.personal_voucher_code?.trim() || "";
  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  if (personalVoucherCode) {
    const voucherResult = await resolvePersonalVoucherForTrip({
      admin: adminClient,
      code: personalVoucherCode,
      customerId: ctx.customerId,
      estimatedFarePence: grossFarePence,
    }).catch(() => null);
    if (voucherResult?.ok) {
      appliedPersonalVoucherId = voucherResult.resolved.voucherId;
      appliedPersonalVoucherCode = voucherResult.resolved.voucherCode;
      voucherDiscountPence = voucherResult.resolved.discountPence;
      finalFarePence = Math.max(0, grossFarePence - voucherDiscountPence);
      discountSource = "personal_voucher";
    }
  } else {
    const resolved = await resolveBestOfferForTrip({
      admin: adminClient,
      serviceAreaId: ctx.serviceAreaId,
      estimatedFarePence: grossFarePence,
      userId: ctx.userId,
      customerId: ctx.customerId,
    }).catch(() => null);
    if (resolved && resolved.discountPence > 0) {
      appliedOfferId = resolved.offerId;
      appliedDiscountPence = resolved.discountPence;
      finalFarePence = resolved.finalFarePence;
      discountSource = "global_offer";
    }
  }

  let fareBreakdownJson: Record<string, unknown> | null = null;
  let baseFarePence: number | null = null;
  if (body.vehicle_type_id && ctx.serviceAreaId) {
    try {
      const pickup: LatLng = { lat: body.pickup.lat || 0, lng: body.pickup.lng || 0 };
      const dropoff: LatLng = { lat: body.dropoff.lat || 0, lng: body.dropoff.lng || 0 };
      const [fareRes, zonesRes, routesRes, saPricingRes] = await Promise.all([
        supabase.from("fare_pricing_settings").select("*")
          .eq("service_area_id", ctx.serviceAreaId)
          .eq("vehicle_type_id", body.vehicle_type_id)
          .maybeSingle(),
        supabase.from("custom_zones")
          .select("id, name, shape_type, zone_type, metadata, priority, center_lat, center_lng, radius_meters, geo_boundary, service_area_id, region_id")
          .eq("is_active", true)
          .or(`service_area_id.eq.${ctx.serviceAreaId},region_id.eq.${ctx.regionId}`),
        supabase.from("zone_route_pricing")
          .select(ZONE_ROUTE_PRICING_SELECT)
          .eq("is_active", true)
          .or(`service_area_id.eq.${ctx.serviceAreaId},service_area_id.is.null`),
        supabase.from("service_area_pricing_settings")
          .select("airport_charge")
          .eq("service_area_id", ctx.serviceAreaId)
          .maybeSingle(),
      ]);

      if (fareRes.data) {
        const stops = (body.stops || [])
          .map((s) => {
            const lat = Number(s.lat);
            const lng = Number(s.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
            return { lat, lng };
          })
          .filter((p): p is { lat: number; lng: number } => p != null);
        const eb = calculateFare({
          pricing: fareRes.data as FarePricingRow,
          distanceKm: body.estimated_distance || 0,
          durationMin: body.estimated_duration || 0,
          pickup,
          dropoff,
          stops,
          zones: (zonesRes.data || []) as unknown as ZoneRow[],
          zoneRoutes: (routesRes.data || []) as unknown as ZoneRoutePricingRow[],
          serviceAreaId: ctx.serviceAreaId,
          serviceAreaPricingSettings: (saPricingRes.data as Record<string, unknown> | null) ?? null,
          vehicleTypeId: body.vehicle_type_id,
          distanceUnit: ctx.regionDistanceUnit,
        });
        fareBreakdownJson = {
          baseFare: eb.base_fare,
          tripFare: eb.trip_fare,
          distanceCost: eb.distance_cost,
          timeCost: eb.time_cost,
          bookingFee: eb.booking_fee,
          airportCharge: eb.airport_charge,
          fareDetails: eb.fare_details,
          totalFare: eb.final_fare,
          finalFare: eb.final_fare,
          pricing_mode: eb.pricing_mode,
        };
        baseFarePence = negotiationBaseFarePenceFromBreakdown(eb);
      }
    } catch (e) {
      log("post-commit fare engine warning", { err: String(e) });
    }
  }

  const patch: Record<string, unknown> = {
    fare: finalFarePence / 100,
    estimated_fare: finalFarePence / 100,
    estimated_total_pence: finalFarePence,
    final_fare_pence: finalFarePence,
    applied_offer_id: appliedOfferId,
    offer_discount_pence: discountSource === "global_offer" ? appliedDiscountPence : 0,
    voucher_discount_pence: voucherDiscountPence,
    discount_source: discountSource,
    ...(fareBreakdownJson ? { fare_breakdown: fareBreakdownJson } : {}),
    ...(baseFarePence != null ? { base_fare_pence: baseFarePence } : {}),
  };

  const tripData: Record<string, unknown> = { ...patch };
  try {
    applyBookingFareToTripData(
      tripData,
      fareBreakdownJson,
      {
        grossFarePence,
        finalPayableFarePence: finalFarePence,
        offerDiscountPence: discountSource === "global_offer" ? appliedDiscountPence : 0,
        voucherDiscountPence,
        discountSource,
        appliedOfferId,
        appliedPersonalVoucherId,
        appliedPersonalVoucherCode,
        pricingSource: "booking_post_commit",
      },
    );
    Object.assign(patch, tripData);
  } catch (e) {
    log("post-commit financial snapshot warning", { err: String(e) });
  }

  if (!ctx.isScheduled) {
    try {
      const dispatchSettings = await loadDispatchSettings(supabase, ctx.serviceAreaId);
      patch.searching_expires_at = customerSearchExpiresAtIso(dispatchSettings);
      patch.max_broadcast_rounds = maxBroadcastRounds(dispatchSettings, null);
    } catch {
      /* keep insert defaults */
    }
  }

  const { error } = await supabase.from("trips").update(patch).eq("id", tripId);
  if (error) {
    log("post-commit trip fare patch warning", { error: error.message });
  }
}

export function buildBookingPostCommitTasks(ctx: BookingPostCommitContext): PromiseLike<unknown>[] {
  const tripStops = buildTripStops(ctx.tripId, ctx.body);
  const tasks: PromiseLike<unknown>[] = [
    enrichTripFareAsync(ctx),
  ];

  if (ctx.paymentProvider === "revolut") {
    const platformPaymentMethodId = ctx.preauthMetadata.platform_payment_method_id ?? null;
    tasks.push((async () => {
      try {
        const merchant = await resolveRevolutMerchantContext(ctx.supabase, "live");
        await finalizeRevolutTokenCapture(ctx.supabase, {
          environment: merchant.environment,
          secretKey: merchant.secretKey,
          orderId: ctx.paymentRefId,
          userId: ctx.userId,
          platformPaymentMethodId,
          orderMetadata: ctx.preauthMetadata,
        });
      } catch (e) {
        ctx.log("post-commit Revolut token capture warning", { error: String(e) });
      }
    })());
  }

  if (!ctx.isScheduled) {
    tasks.push((async () => {
      ctx.bookingWaterfall.startStep(
        "dispatch_started",
        "bookingPostCommit.ts:invokeAutoDispatch",
      );
      const dispatchStartedAt = Date.now();
      const dispatchResult = await invokeAutoDispatch(ctx.supabase, { trip_id: ctx.tripId });
      const dispatchFinishedAt = Date.now();
      const { data: firstOffer } = await ctx.supabase
        .from("ride_offers")
        .select("id, created_at")
        .eq("trip_id", ctx.tripId)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      ctx.bookingWaterfall.completeStep(
        "dispatch_started",
        "bookingPostCommit.ts:invokeAutoDispatch",
        {
          trip_id: ctx.tripId,
          dispatch_ok: dispatchResult.ok,
          dispatch_ms: dispatchFinishedAt - dispatchStartedAt,
          dispatch_started_ms: dispatchStartedAt,
          ride_offers_created_ms: firstOffer?.created_at
            ? new Date(String(firstOffer.created_at)).getTime()
            : null,
        },
      );
      if (ctx.body.client_action_id) {
        await markPaymentSessionDispatching(ctx.supabase, {
          clientActionId: ctx.body.client_action_id,
          tripId: ctx.tripId,
        });
      }
      await ctx.bookingWaterfall.persistOpsLog(ctx.supabase, {
        trip_id: ctx.tripId,
        phase: "post_trip_insert",
      });
    })());
  }

  tasks.push(
    ctx.supabase.from("payments").insert({
      trip_id: ctx.tripId,
      provider_order_id: ctx.paymentRefId,
      payment_provider: "revolut",
      status: "preauth_authorized",
      amount_pence: ctx.preauthAmountPence,
      gross_amount_pence: ctx.grossFarePence,
      currency: ctx.regionCurrencyCode.toLowerCase(),
      capture_method: "manual",
      metadata: {
        gross_fare_pence: ctx.grossFarePence,
        final_payable_fare_pence: ctx.finalFarePence,
        verified_server_side: true,
        enrichment: "post_commit",
      },
    }).then(({ error }) => {
      if (error?.code !== "23505" && error) {
        ctx.log("post-commit payments warning", { error: error.message });
      }
    }),
    recordPaymentAuthorizationEvent(ctx.supabase, {
      tripId: ctx.tripId,
      fareRevisionNumber: 0,
      operation: "initial_auth",
      idempotencyKey: buildPreauthIdempotencyKey({
        tripId: ctx.tripId,
        clientActionId: ctx.body.client_action_id,
      }),
      stripePaymentIntentId: ctx.paymentRefId,
      amountPence: ctx.preauthAmountPence,
      status: "succeeded",
    }).catch((e) => {
      ctx.log("post-commit auth ledger warning", { error: String(e) });
    }),
    ctx.supabase.from("trip_stops").insert(tripStops).then(({ error }) => {
      if (error) ctx.log("post-commit trip_stops warning", { error: error.message });
    }),
  );

  if (!ctx.isScheduled) {
    tasks.push(
      ctx.supabase
        .from("customers")
        .update({ active_trip_id: ctx.tripId })
        .eq("user_id", ctx.userId)
        .then(({ error }) => {
          if (error) ctx.log("post-commit active_trip warning", { error: error.message });
        }),
    );
  }

  tasks.push(
    ctx.supabase.rpc("assign_trip_number", {
      p_trip_id: ctx.tripId,
      p_service_area_id: ctx.serviceAreaId,
    }).then(({ error }) => {
      if (error) ctx.log("post-commit trip_number warning", { error: error.message });
    }),
  );

  return tasks;
}
