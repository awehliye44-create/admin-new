/**
 * P0 — Single booking SSOT: validate → hold authorised → trip insert → dispatch (async).
 * All paid booking entry points must commit trips through create-trip-after-payment.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { buildTripPaymentSyncPatch } from "./dynamicPaymentWorkflow.ts";
import {
  applyBookingFinancialSnapshotToTripData,
  type DiscountSource,
} from "./tripDisplayFareSSOT.ts";

export type BookingLocation = {
  address: string;
  lat: number;
  lng: number;
};

export type BookingCommitBody = {
  payment_intent_id: string;
  client_action_id: string;
  pickup: BookingLocation;
  dropoff: BookingLocation;
  stops?: BookingLocation[];
  when: "NOW" | "SCHEDULED";
  scheduled_at?: string | null;
  passenger_name?: string;
  passenger_phone?: string;
  estimated_fare: number;
  original_estimated_fare?: number;
  discount_amount?: number;
  discount_source?: "global_offer" | "personal_voucher";
  estimated_distance?: number;
  estimated_duration?: number;
  payment_method: string;
  vehicle_type_id?: string;
  service_area_id?: string | null;
  pre_assigned_driver_id?: string | null;
  booking_type?: "ride" | "delivery" | "scan_go";
  delivery_type?: string;
  delivery_metadata?: Record<string, unknown>;
  special_instructions?: string;
  personal_voucher_code?: string;
  qr_session_id?: string;
  internal_user_id?: string;
};

export function applyBookingTypeFieldsToTrip(
  tripData: Record<string, unknown>,
  body: Pick<
    BookingCommitBody,
    | "booking_type"
    | "delivery_type"
    | "delivery_metadata"
    | "special_instructions"
    | "pre_assigned_driver_id"
    | "qr_session_id"
  >,
): void {
  const bookingType = (body.booking_type || "ride").toLowerCase();
  tripData.booking_type = bookingType;

  if (bookingType === "delivery") {
    tripData.job_type = "delivery";
    if (body.delivery_type) tripData.delivery_type = body.delivery_type;
    if (body.delivery_metadata) tripData.delivery_metadata = body.delivery_metadata;
    if (body.special_instructions) tripData.special_instructions = body.special_instructions;
    return;
  }

  if (bookingType === "scan_go") {
    // trips.scan_go / locked_driver_id / qr_session_id were dropped (20260903121500).
    // Keep dispatch/status semantics via remaining columns only (Scan & Go unused).
    tripData.dispatch_mode = "locked_driver";
    tripData.dispatch_status = "locked";
    tripData.broadcast_enabled = false;
    tripData.status = "pending";
    tripData.negotiation_disabled = true;
    tripData.negotiation_allowed = false;
    tripData.trip_type = "scan_go";
    const lockedDriverId = body.pre_assigned_driver_id?.trim() || null;
    if (lockedDriverId) {
      tripData.pre_assigned_driver_id = lockedDriverId;
      tripData.current_offer_driver_id = lockedDriverId;
      tripData.negotiation_owner_driver_id = lockedDriverId;
    }
  }
}

export type MinimalTripBuildInput = {
  body: BookingCommitBody;
  customerId: string;
  serviceAreaId: string;
  serviceAreaCode: string | null;
  regionId: string | null;
  regionCurrencyCode: string;
  regionDistanceUnit: string;
  paymentProvider: "stripe" | "revolut";
  paymentRefId: string;
  preauthAmountPence: number;
  paymentSessionId?: string | null;
  sessionFareSnapshot?: Record<string, unknown> | null;
};

export function buildMinimalTripInsertRow(input: MinimalTripBuildInput): Record<string, unknown> {
  const { body, customerId } = input;
  const isScheduled = body.when === "SCHEDULED";
  const intermediateStops = body.stops || [];
  const totalStops = 1 + intermediateStops.length + 1;
  const tripCode = Math.floor(100000 + Math.random() * 900000).toString();

  const grossFarePence = body.original_estimated_fare != null && body.original_estimated_fare > 0
    ? Math.round(body.original_estimated_fare * 100)
    : Math.round(body.estimated_fare * 100);
  const finalFarePence = Math.round(body.estimated_fare * 100);

  const voucherDiscountPence = body.discount_source === "personal_voucher" && body.discount_amount
    ? Math.round(body.discount_amount * 100)
    : 0;
  const offerDiscountPence = body.discount_source === "global_offer" && body.discount_amount
    ? Math.round(body.discount_amount * 100)
    : Math.max(0, grossFarePence - finalFarePence);
  const discountSource = (body.discount_source ?? null) as DiscountSource;

  let scheduledBroadcastAt: string | null = null;
  let scheduledConvertAt: string | null = null;
  if (isScheduled && body.scheduled_at) {
    const t = new Date(body.scheduled_at);
    scheduledBroadcastAt = new Date(t.getTime() - 30 * 60 * 1000).toISOString();
    scheduledConvertAt = new Date(t.getTime() - 10 * 60 * 1000).toISOString();
  }

  const defaultSearchExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const requestedMethod = body.payment_method || "card";
  const isScanGo = (body.booking_type || "ride").toLowerCase() === "scan_go";

  const tripData: Record<string, unknown> = {
    passenger_id: customerId,
    passenger_name: body.passenger_name || "Guest",
    passenger_phone: body.passenger_phone || "",
    pickup_address: body.pickup.address,
    pickup_latitude: body.pickup.lat || 0,
    pickup_longitude: body.pickup.lng || 0,
    dropoff_address: body.dropoff.address,
    dropoff_latitude: body.dropoff.lat || 0,
    dropoff_longitude: body.dropoff.lng || 0,
    stops: intermediateStops,
    status: isScanGo ? "pending" : (isScheduled ? "scheduled" : "searching"),
    scheduled_at: isScheduled ? body.scheduled_at : null,
    scheduled_status: isScheduled ? "scheduled" : null,
    dispatch_mode: isScanGo ? "locked_driver" : (isScheduled ? "scheduled" : "instant"),
    scheduled_broadcast_at: scheduledBroadcastAt,
    scheduled_convert_at: scheduledConvertAt,
    client_action_id: body.client_action_id,
    trip_code: tripCode,
    authorised_amount_pence: input.preauthAmountPence,
    preauth_buffer_pence: Math.max(0, input.preauthAmountPence - finalFarePence),
    payment_hold_status: input.paymentProvider === "revolut" ? "authorised_hold" : null,
    ...(input.paymentSessionId ? { payment_session_id: input.paymentSessionId } : {}),
    estimated_distance_km: body.estimated_distance || 0,
    estimated_duration_minutes: body.estimated_duration || 0,
    payment_method: requestedMethod,
    payment_type: requestedMethod,
    payment_status: "preauth_authorized",
    payment_state: "booking_created",
    original_payment_method: requestedMethod,
    ...(input.paymentProvider === "revolut"
      ? {
        payment_provider: "revolut",
        provider_order_id: input.paymentRefId,
      }
      : {
        stripe_payment_intent_id: input.paymentRefId,
      }),
    payment_intent_version: 1,
    fare_revision_number: 0,
    ...buildTripPaymentSyncPatch({
      paymentIntentId: input.paymentRefId,
      authorizedAmountPence: input.preauthAmountPence,
      totalAuthorizedAmountPence: input.preauthAmountPence,
      idempotencyKey: body.client_action_id,
      paymentCoverageStatus: "authorized",
      outstandingBalancePence: 0,
    }),
    trip_type: isScanGo ? "scan_go" : (isScheduled ? "scheduled" : "immediate"),
    currency: input.regionCurrencyCode.toUpperCase(),
    currency_code: input.regionCurrencyCode.toLowerCase(),
    distance_unit: input.regionDistanceUnit,
    region_id: input.regionId,
    surge_multiplier: 1.0,
    is_scheduled: isScheduled,
    job_type: "ride",
    total_stops: totalStops,
    current_stop_index: 0,
    service_area_id: input.serviceAreaId,
    service_area_code: input.serviceAreaCode,
    vehicle_type_id: body.vehicle_type_id || null,
    searching_expires_at: isScheduled || isScanGo ? null : defaultSearchExpiresAt,
    max_broadcast_rounds: isScheduled || isScanGo ? null : 3,
  };

  if (!isScanGo && body.pre_assigned_driver_id) {
    tripData.pre_assigned_driver_id = body.pre_assigned_driver_id;
  }

  applyBookingFinancialSnapshotToTripData(
    tripData,
    input.sessionFareSnapshot ?? null,
    {
      grossFarePence,
      finalPayableFarePence: finalFarePence,
      offerDiscountPence,
      voucherDiscountPence,
      discountSource,
      pricingSource: "booking_ssot_minimal_commit",
    },
  );

  applyBookingTypeFieldsToTrip(tripData, body);
  return tripData;
}

/** Invoke create-trip-after-payment (single production trip insert path). */
export async function invokeBookingCommitAfterPayment(
  args: {
    supabaseUrl: string;
    serviceRoleKey: string;
    userId: string;
    body: BookingCommitBody;
    internalFinalize?: boolean;
    userJwt?: string;
  },
): Promise<{
  ok: boolean;
  ride_id?: string;
  trip_code?: string;
  status?: string;
  idempotent?: boolean;
  error?: string;
  code?: string;
}> {
  const internalSecret = Deno.env.get("ONECAB_INTERNAL_FINALIZE_SECRET");
  if (args.internalFinalize && internalSecret) {
    headers["x-onecab-internal-finalize"] = internalSecret;
    payload.internal_user_id = args.userId;
  }

  const authToken = args.internalFinalize ? args.serviceRoleKey : args.userJwt;
  if (!authToken) {
    return { ok: false, error: "missing_auth_token" };
  }
  headers.Authorization = `Bearer ${authToken}`;

  try {
    const res = await fetch(`${args.supabaseUrl}/functions/v1/create-trip-after-payment`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: String(data.error ?? data.code ?? res.status),
        code: data.code as string | undefined,
      };
    }
    return {
      ok: true,
      ride_id: (data.ride_id ?? data.trip_id) as string | undefined,
      trip_code: data.trip_code as string | undefined,
      status: data.status as string | undefined,
      idempotent: data.idempotent === true,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function isProductionTripInsertPath(functionName: string): boolean {
  return functionName === "create-trip-after-payment";
}
