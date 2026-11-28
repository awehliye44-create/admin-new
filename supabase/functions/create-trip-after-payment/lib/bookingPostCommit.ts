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
} from "../../_shared/pricing-engine.ts";
import {
  customerSearchExpiresAtIso,
  loadDispatchSettings,
  maxBroadcastRounds,
} from "../../_shared/dispatch-settings.ts";
import { invokeAutoDispatch } from "../../_shared/dispatchOrchestrator.ts";
import { applyBookingFareToTripData } from "./persist-booking-fare.ts";
import {
  applyAuthoritativeAirportSplitToTripData,
  decideDispatchAfterFareEnrich,
  resolveAirportPenceForPostCommitEnrich,
  resolveQuoteAirportChargePence,
  type FareEnrichDispatchDecision,
} from "../../_shared/airportChargeFareSplitSSOT.ts";
import {
  evaluateAirportPersistReadiness,
  resolveAuthoritativeAirportSplitForBooking,
} from "./authoritativeAirportBookingPersistSSOT.ts";
import { resolveBestOfferForTrip } from "../../_shared/resolve-offer.ts";
import { resolvePersonalVoucherForTrip } from "../../_shared/resolve-personal-voucher.ts";
import {
  buildPreauthIdempotencyKey,
  recordPaymentAuthorizationEvent,
} from "../../_shared/dynamicPaymentWorkflow.ts";
import { finalizeRevolutTokenCapture } from "../../_shared/revolutSavedCardWalletLink.ts";
import { writePayableSnapshotOrLog } from "../../_shared/writePayableSnapshotOrLogSSOT.ts";
import { recordPaymentFinancialEvent } from "../../_shared/paymentFinancialDiagnosticsSSOT.ts";
import { resolveRevolutMerchantContext } from "../../_shared/revolutMerchantContext.ts";
import {
  markPaymentSessionDispatching,
} from "../../_shared/paymentSessionSSOT.ts";
import type { BookingWaterfallCollector } from "../../_shared/bookingWaterfallTelemetry.ts";
import type { BookingCommitBody } from "./bookingSSOT.ts";
import { assertPaymentGate, PaymentGateError } from "../../_shared/paymentGate.ts";
import {
  attemptScheduledMarketplaceAutoPublish,
  SCHEDULED_MARKETPLACE_AUTO_PUBLISH_VIA,
} from "../../_shared/scheduledMarketplaceAutoPublishSSOT.ts";
import { notifyScheduledMarketplaceOpen } from "../../_shared/scheduledMarketplaceNotifySSOT.ts";

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

const AIRPORT_ABSENT_DISPATCH: FareEnrichDispatchDecision = {
  allowDispatch: true,
  holdBroadcast: false,
  reason: "airport_absent",
};

const BOOKING_PAYABLE_TRIP_SELECT =
  "locked_base_fare_pence, final_customer_fare_pence, final_fare_pence, gross_fare_pence, pickup_waiting_charge_pence, stop_waiting_charge_pence, offer_discount_pence, voucher_discount_pence, airport_charge_pence, other_pass_through_charges_pence, tip_pence, tip_amount_pence, currency_code, commissionable_fare_pence, fare_breakdown, fare_snapshot_json, fare_locked";

/**
 * #92J — Booking payable snapshot writer (PLATFORM_COLLECTED).
 * Must run on the request path after trip insert (not waitUntil-only).
 * MK-261125-006: waitUntil enrich aborted → zero booking snap, zero fail event.
 */
export async function persistBookingPayableSnapshot(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    trip: Record<string, unknown>;
    paymentSessionId?: string | null;
    logPrefix: string;
    log?: (step: string, details?: unknown) => void;
    /**
     * Sync after-insert path: skip if a booking snap already exists (retry /
     * crash recovery). Enrich rewrite may pass false to append a new version
     * after airport/discount patch — never creates a second trip or payment.
     */
    skipIfBookingExists?: boolean;
  },
): Promise<{ ok: true; id: string; version: number } | { ok: false; error: string }> {
  if (args.skipIfBookingExists !== false) {
    const { data: existing } = await supabase
      .from("payment_payable_snapshots")
      .select("id, version")
      .eq("trip_id", args.tripId)
      .eq("source", "booking")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing?.id) {
      args.log?.("payable_snapshot_booking_already_present", {
        trip_id: args.tripId,
        snapshot_id: existing.id,
        version: existing.version,
      });
      return {
        ok: true,
        id: String(existing.id),
        version: Number(existing.version) || 1,
      };
    }
  }
  let lastErr: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const snap = await writePayableSnapshotOrLog(supabase, {
      tripId: args.tripId,
      trip: args.trip,
      source: "booking",
      waitingBasis: "columns",
      paymentSessionId: args.paymentSessionId ?? null,
      logPrefix: args.logPrefix,
    });
    if (snap.ok) {
      args.log?.("payable_snapshot_booking_ok", {
        trip_id: args.tripId,
        snapshot_id: snap.id,
        version: snap.version,
        attempt: attempt + 1,
      });
      return snap;
    }
    lastErr = snap.error;
  }
  return { ok: false, error: lastErr ?? "booking_snapshot_persist_failed" };
}

/**
 * Sync booking snapshot immediately after trips.insert for PLATFORM_COLLECTED.
 * Uses committed insert fare columns; enrich may rewrite after airport/discount.
 */
export async function persistBookingPayableSnapshotAfterInsert(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    paymentSessionId?: string | null;
    log?: (step: string, details?: unknown) => void;
  },
): Promise<{ ok: true; id: string; version: number } | { ok: false; error: string }> {
  const { data: snapTrip, error } = await supabase
    .from("trips")
    .select(BOOKING_PAYABLE_TRIP_SELECT)
    .eq("id", args.tripId)
    .maybeSingle();
  if (error || !snapTrip) {
    const msg = error?.message ?? "booking_snapshot_trip_row_missing";
    args.log?.("payable_snapshot_booking_sync_read_failed", {
      trip_id: args.tripId,
      error: msg,
    });
    await recordPaymentFinancialEvent(supabase, {
      paymentSessionId: args.paymentSessionId ?? null,
      tripId: args.tripId,
      opType: "RECONCILE",
      eventType: "payable_snapshot_persist_failed",
      detail: { source: "booking", error: msg, phase: "sync_after_insert_read" },
    }).catch(() => undefined);
    return { ok: false, error: msg };
  }
  return persistBookingPayableSnapshot(supabase, {
    tripId: args.tripId,
    trip: snapTrip as Record<string, unknown>,
    paymentSessionId: args.paymentSessionId,
    logPrefix: "bookingPayableSnapshotSync",
    log: args.log,
    skipIfBookingExists: true,
  });
}

async function enrichTripFareAsync(
  ctx: BookingPostCommitContext,
): Promise<FareEnrichDispatchDecision> {
  const { body, supabase, tripId, log } = ctx;
  let appliedOfferId: string | null = null;
  let appliedDiscountPence = 0;
  let appliedPersonalVoucherId: string | null = null;
  let appliedPersonalVoucherCode: string | null = null;
  let voucherDiscountPence = 0;
  let discountSource: "personal_voucher" | "global_offer" | null = null;
  let finalFarePence = ctx.finalFarePence;
  let grossFarePence = ctx.grossFarePence;

  // Read existing authoritative stamp before any recalculate — never overwrite
  // a valid airport_charge_pence with 0 / a conflicting engine result.
  const { data: existingTrip } = await supabase
    .from("trips")
    .select("airport_charge_pence, commissionable_fare_pence, fare_breakdown, fare_snapshot_json")
    .eq("id", tripId)
    .maybeSingle();
  const existingAirportPence = Math.max(
    0,
    Math.round(Number((existingTrip as { airport_charge_pence?: number } | null)?.airport_charge_pence) || 0),
  );

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

  const recalculatedAirportPence = resolveQuoteAirportChargePence(fareBreakdownJson);

  // Prefer consumed server fare quote when insert left airport at 0.
  let authoritativeQuoteAirport = 0;
  let authoritativeSplit = null as ReturnType<
    typeof evaluateAirportPersistReadiness
  >["split"];
  if (existingAirportPence <= 0) {
    const splitResult = await resolveAuthoritativeAirportSplitForBooking(supabase, {
      paymentSessionId: ctx.paymentSessionId,
      clientActionId: body.client_action_id ?? null,
      userId: ctx.userId,
      vehicleTypeId: String(body.vehicle_type_id ?? ""),
      serviceAreaId: ctx.serviceAreaId,
      payablePence: finalFarePence,
    });
    const readiness = evaluateAirportPersistReadiness(splitResult);
    authoritativeQuoteAirport = readiness.requiredAirportPence
      || (readiness.split?.airportChargePence ?? 0);
    authoritativeSplit = readiness.split;
  }

  const airportResolve = resolveAirportPenceForPostCommitEnrich({
    existingAirportChargePence: existingAirportPence,
    recalculatedAirportPence,
    authoritativeQuoteAirportPence: authoritativeQuoteAirport,
  });

  const patch: Record<string, unknown> = {
    fare: finalFarePence / 100,
    estimated_fare: finalFarePence / 100,
    estimated_total_pence: finalFarePence,
    final_fare_pence: finalFarePence,
    applied_offer_id: appliedOfferId,
    offer_discount_pence: discountSource === "global_offer" ? appliedDiscountPence : 0,
    voucher_discount_pence: voucherDiscountPence,
    discount_source: discountSource,
    ...(baseFarePence != null ? { base_fare_pence: baseFarePence } : {}),
  };

  // Never replace a valid stamped airport/breakdown with recalculated zero.
  if (airportResolve.preserveExisting) {
    // Keep existing airport_charge_pence / commissionable / fare_breakdown untouched.
  } else if (authoritativeSplit && airportResolve.airportPenceForPatch > 0) {
    applyAuthoritativeAirportSplitToTripData(patch, authoritativeSplit);
  } else if (fareBreakdownJson && !airportResolve.preserveExisting) {
    patch.fare_breakdown = fareBreakdownJson;
  }

  const tripData: Record<string, unknown> = { ...patch };
  try {
    applyBookingFareToTripData(
      tripData,
      airportResolve.preserveExisting
        ? (asRecordSafe(existingTrip?.fare_breakdown) ?? fareBreakdownJson)
        : (authoritativeSplit?.fareBreakdown ?? fareBreakdownJson),
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
        authoritativeFareBreakdown: airportResolve.preserveExisting
          ? null
          : (authoritativeSplit?.fareBreakdown ?? null),
      },
    );
    if (airportResolve.preserveExisting) {
      // Strip airport fields from patch so update cannot zero them.
      delete tripData.airport_charge_pence;
      delete tripData.commissionable_fare_pence;
      delete tripData.fare_breakdown;
      if (tripData.fare_snapshot_json && typeof tripData.fare_snapshot_json === "object") {
        const snap = { ...(tripData.fare_snapshot_json as Record<string, unknown>) };
        // Keep snapshot money fields but do not clear airport keys on the row.
        tripData.fare_snapshot_json = snap;
      }
    }
    Object.assign(patch, tripData);
  } catch (e) {
    log("post-commit financial snapshot warning", { err: String(e) });
  }

  try {
    const dispatchSettings = await loadDispatchSettings(supabase, ctx.serviceAreaId);
    // Absolute sequences = Admin cycles × 3 (same stamp for scheduled + instant).
    patch.max_broadcast_rounds = maxBroadcastRounds(dispatchSettings, null);
    if (!ctx.isScheduled) {
      patch.searching_expires_at = customerSearchExpiresAtIso(dispatchSettings);
    }
  } catch {
    /* keep insert defaults */
  }

  const quoteAirportPence = airportResolve.quoteAirportPenceForDispatchGate;
  const { error } = await supabase.from("trips").update(patch).eq("id", tripId);
  if (error) {
    log("post-commit trip fare patch warning", { error: error.message });
  } else {
    const { data: snapTrip } = await supabase
      .from("trips")
      .select(BOOKING_PAYABLE_TRIP_SELECT)
      .eq("id", tripId)
      .maybeSingle();
    if (snapTrip) {
      // Post-enrich rewrite (airport/discount). Primary booking snap is sync
      // after insert — see persistBookingPayableSnapshotAfterInsert.
      // Enrich may append a new booking version after airport/discount patch.
      // Never posts CAPTURE / never creates a second trip.
      const snap = await persistBookingPayableSnapshot(supabase, {
        tripId,
        trip: snapTrip as Record<string, unknown>,
        paymentSessionId: ctx.paymentSessionId,
        logPrefix: "bookingPostCommit",
        log,
        skipIfBookingExists: false,
      });
      if (!snap.ok) {
        log("payable_snapshot_booking_soft_fail", {
          trip_id: tripId,
          error: snap.error,
          recovery: "completion_or_admin_capture_rewrites_before_post",
        });
      }
    }
  }

  let persistedAirportPence: number | null = existingAirportPence > 0
    ? existingAirportPence
    : null;
  let updateFailed = Boolean(error);
  if (!updateFailed && quoteAirportPence > 0) {
    const { data: written, error: readErr } = await supabase
      .from("trips")
      .select("airport_charge_pence")
      .eq("id", tripId)
      .maybeSingle();
    if (readErr || !written) {
      updateFailed = true;
      log("AIRPORT_FARE_PERSIST_READBACK_FAILED", {
        trip_id: tripId,
        error: readErr?.message ?? "missing_row",
      });
    } else {
      persistedAirportPence = Number(written.airport_charge_pence);
    }
  }

  const decision = decideDispatchAfterFareEnrich({
    quoteAirportPence,
    persistedAirportPence,
    updateFailed,
  });
  if (decision.holdBroadcast) {
    log("AIRPORT_FARE_PERSIST_FAILED_DISPATCH_BLOCKED", {
      trip_id: tripId,
      quote_airport_pence: quoteAirportPence,
      persisted_airport_pence: persistedAirportPence,
      update_error: error?.message ?? null,
    });
    const { error: holdErr } = await supabase
      .from("trips")
      .update({
        broadcast_enabled: false,
        scheduled_hold_reason: "airport_pricing",
        updated_at: new Date().toISOString(),
      })
      .eq("id", tripId);
    if (holdErr) {
      log("AIRPORT_FARE_PERSIST_HOLD_FAILED", {
        trip_id: tripId,
        error: holdErr.message,
      });
    }
  }
  return decision;
}

function asRecordSafe(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function buildBookingPostCommitTasks(ctx: BookingPostCommitContext): PromiseLike<unknown>[] {
  const tripStops = buildTripStops(ctx.tripId, ctx.body);
  // Fare enrich writes airport_charge_pence before dispatch. Offer insert stamps
  // net from that column; running them in parallel commissions the folded payable.
  const fareEnrich = enrichTripFareAsync(ctx);
  const tasks: PromiseLike<unknown>[] = [
    fareEnrich,
  ];

  if (ctx.paymentProvider === "revolut") {
    const platformPaymentMethodId = ctx.preauthMetadata.platform_payment_method_id ?? null;
    const saveRequested = ctx.preauthMetadata.save_card_eligible === "true";
    if (saveRequested && platformPaymentMethodId) {
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
            markFailedOnMiss: true,
            // Same setup ladder as confirm waitUntil — Revolut SPM often lags authorise.
            pollProfile: "setup",
          });
        } catch (e) {
          ctx.log("post-commit Revolut token capture warning", { error: String(e) });
        }
      })());
    }
  }

  if (ctx.isScheduled) {
    // Phase 3: after fare enrich gates, auto-publish to Scheduled Jobs Requested.
    // Create remains admin_held until this CAS Make Available (idempotent).
    tasks.push((async () => {
      const enrich = await fareEnrich.catch((e) => {
        ctx.log("fare enrich before scheduled marketplace publish", { err: String(e) });
        return AIRPORT_ABSENT_DISPATCH;
      });
      if (enrich.holdBroadcast || !enrich.allowDispatch) {
        ctx.log("SCHEDULED_MARKETPLACE_AUTO_PUBLISH_BLOCKED", {
          trip_id: ctx.tripId,
          reason: enrich.reason,
        });
        return;
      }
      try {
        await assertPaymentGate(ctx.supabase, ctx.tripId);
      } catch (gateErr) {
        const detail = gateErr instanceof PaymentGateError
          ? gateErr.message
          : String((gateErr as Error)?.message ?? gateErr);
        ctx.log("SCHEDULED_MARKETPLACE_AUTO_PUBLISH_PAYMENT_GATE", {
          trip_id: ctx.tripId,
          detail,
        });
        await ctx.supabase
          .from("trips")
          .update({
            scheduled_status: "payment_gate_blocked",
            scheduled_hold_reason: "payment_gate",
            updated_at: new Date().toISOString(),
          })
          .eq("id", ctx.tripId)
          .eq("scheduled_status", "admin_held")
          .in("scheduled_hold_reason", ["publication_pending", "publication_retry"]);
        return;
      }
      const { data: tripRow } = await ctx.supabase
        .from("trips")
        .select(
          "id, dispatch_mode, status, scheduled_status, scheduled_at, scheduled_broadcast_at, scheduled_hold_reason, scheduled_publish_attempts, driver_id, confirmed_driver_id, broadcast_enabled, airport_charge_pence, pending_release_kind, pending_release_at, booking_source, service_area_id, vehicle_type_id, vehicle_type, completed_at, cancelled_at, pickup_address, trip_code, trip_number",
        )
        .eq("id", ctx.tripId)
        .maybeSingle();
      if (!tripRow) {
        ctx.log("SCHEDULED_MARKETPLACE_AUTO_PUBLISH_MISSING_TRIP", { trip_id: ctx.tripId });
        return;
      }
      const nowIso = new Date().toISOString();
      const result = await attemptScheduledMarketplaceAutoPublish(ctx.supabase, {
        tripId: ctx.tripId,
        trip: tripRow,
        nowIso,
        via: SCHEDULED_MARKETPLACE_AUTO_PUBLISH_VIA.post_commit,
        allowUnknownBookingSource: true,
        stampRetryOnFailure: true,
      });
      ctx.log("SCHEDULED_MARKETPLACE_AUTO_PUBLISH", result);
      if (result.published) {
        const { data: published } = await ctx.supabase
          .from("trips")
          .select(
            "id, service_area_id, pickup_address, scheduled_at, trip_code, trip_number, scheduled_status, scheduled_broadcast_at, confirmed_driver_id, driver_id, dispatch_mode, status",
          )
          .eq("id", ctx.tripId)
          .maybeSingle();
        if (published) {
          try {
            const notify = await notifyScheduledMarketplaceOpen(ctx.supabase, published);
            ctx.log("SCHEDULED_MARKETPLACE_NOTIFY", {
              trip_id: ctx.tripId,
              notified: notify.notified,
              suppressed: notify.suppressed,
              via: "post_commit_auto_publish",
            });
          } catch (notifyErr) {
            ctx.log("SCHEDULED_MARKETPLACE_NOTIFY_FAILED", {
              trip_id: ctx.tripId,
              error: String(notifyErr),
            });
          }
        }
      }
    })());
  } else {
    tasks.push((async () => {
      const enrich = await fareEnrich.catch((e) => {
        ctx.log("fare enrich before dispatch", { err: String(e) });
        // Unknown throw has no quote airport. Normal trips still dispatch.
        // A known airport persist failure returns airport_persist_failed instead of throwing.
        return AIRPORT_ABSENT_DISPATCH;
      });
      if (!enrich.allowDispatch) {
        ctx.log("AIRPORT_FARE_PERSIST_FAILED_DISPATCH_BLOCKED", {
          trip_id: ctx.tripId,
          reason: enrich.reason,
        });
        return;
      }
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
      providerOrderId: ctx.paymentRefId,
      amountPence: ctx.preauthAmountPence,
      status: "succeeded",
      metadata: {
        provider: "revolut",
        provider_order_id: ctx.paymentRefId,
      },
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
