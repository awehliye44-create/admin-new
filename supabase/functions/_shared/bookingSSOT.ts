/**
 * P0 — Single booking SSOT: validate → hold authorised → trip insert → dispatch (async).
 * All paid booking entry points must commit trips through create-trip-after-payment.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { buildTripPaymentSyncPatch } from "./dynamicPaymentWorkflow.ts";
import { resolvePersistedTripBookingSource } from "./presetNegotiationEligibility.ts";
import {
  computeScheduledDispatchAnchors,
  resolveScheduledDispatchConfig,
  type ScheduledDispatchConfig,
} from "./scheduledDispatchConfig.ts";
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
  booking_type?: "ride" | "delivery";
  delivery_type?: string;
  delivery_metadata?: Record<string, unknown>;
  special_instructions?: string;
  personal_voucher_code?: string;
  qr_session_id?: string;
  internal_user_id?: string;
  booking_source?: string | null;
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

}
export type MinimalTripBuildInput = {
  body: BookingCommitBody;
  customerId: string;
  /** Profile fields from `customers` — used when body omits passenger_name (self-book). */
  customerProfile?: {
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
  } | null;
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
  requestReferer?: string | null;
  requestOrigin?: string | null;
  /** Admin Scheduled Rides Dispatch tab — required for correct broadcast/convert anchors. */
  scheduledDispatchConfig?: ScheduledDispatchConfig | null;
  /** Wall clock for anchor math (tests). Defaults to Date.now(). */
  nowMs?: number;
};

/** Build "First Last" from customer profile fields. */
export function formatCustomerPassengerName(input: {
  first_name?: string | null;
  last_name?: string | null;
} | null | undefined): string | null {
  if (!input) return null;
  const name = [input.first_name, input.last_name]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || null;
}

/**
 * Resolve denormalized trip passenger_name / phone.
 * Prefer explicit body (book-for-other); else customers profile; else Guest.
 */
export function resolveTripPassengerIdentity(input: {
  bodyName?: string | null;
  bodyPhone?: string | null;
  customerProfile?: {
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
  } | null;
}): { passenger_name: string; passenger_phone: string } {
  const bodyName = typeof input.bodyName === "string" ? input.bodyName.trim() : "";
  const profileName = formatCustomerPassengerName(input.customerProfile);
  const passenger_name = bodyName || profileName || "Guest";

  const bodyPhone = typeof input.bodyPhone === "string" ? input.bodyPhone.trim() : "";
  const profilePhone =
    typeof input.customerProfile?.phone === "string" ? input.customerProfile.phone.trim() : "";
  const passenger_phone = bodyPhone || profilePhone || "";

  return { passenger_name, passenger_phone };
}

export function buildMinimalTripInsertRow(input: MinimalTripBuildInput): Record<string, unknown> {
  const { body, customerId } = input;
  const isScheduled = body.when === "SCHEDULED";
  const intermediateStops = body.stops || [];
  const totalStops = 1 + intermediateStops.length + 1;
  const tripCode = Math.floor(100000 + Math.random() * 900000).toString();

  // P0 #1: prefer payment session fare_snapshot net payable over body floats.
  // Never fall through to gross when session already locked customer payable + discount.
  const sessionSnap = input.sessionFareSnapshot ?? null;
  const sessionInt = (...keys: string[]): number => {
    if (!sessionSnap) return 0;
    for (const key of keys) {
      const n = Math.round(Number(sessionSnap[key] ?? 0));
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  };

  const bodyGrossPence = body.original_estimated_fare != null && body.original_estimated_fare > 0
    ? Math.round(body.original_estimated_fare * 100)
    : Math.round(body.estimated_fare * 100);
  const bodyFinalPence = Math.round(body.estimated_fare * 100);

  const sessionGross = sessionInt("gross_fare_pence", "original_estimated_fare_pence");
  const sessionPayable = sessionInt(
    "final_fare_pence",
    "estimated_total_pence",
    "final_customer_fare_pence",
    "final_payable_fare_pence",
    "authorised_amount_pence",
  );
  const sessionDiscount = sessionInt(
    "offer_discount_pence",
    "discount_amount_pence",
    "discount_pence",
    "voucher_discount_pence",
  );

  const grossFarePence = sessionGross || bodyGrossPence;
  let finalFarePence = sessionPayable || bodyFinalPence;
  // If body accidentally sent gross as estimated_fare while session has net, prefer session.
  if (
    sessionPayable > 0 &&
    bodyFinalPence === grossFarePence &&
    sessionPayable < grossFarePence
  ) {
    finalFarePence = sessionPayable;
  }

  const voucherDiscountPence = body.discount_source === "personal_voucher" && body.discount_amount
    ? Math.round(body.discount_amount * 100)
    : 0;
  const offerDiscountPence = body.discount_source === "global_offer" && body.discount_amount
    ? Math.round(body.discount_amount * 100)
    : sessionDiscount || Math.max(0, grossFarePence - finalFarePence);
  const discountSource = (body.discount_source ?? null) as DiscountSource;

  let scheduledBroadcastAt: string | null = null;
  let scheduledConvertAt: string | null = null;
  if (isScheduled && body.scheduled_at) {
    const cfg =
      input.scheduledDispatchConfig ??
      resolveScheduledDispatchConfig(null);
    const anchors = computeScheduledDispatchAnchors({
      scheduledAtIso: body.scheduled_at,
      nowMs: input.nowMs,
      urgentTriggerMinutesBeforePickup: cfg.urgentTriggerMinutesBeforePickup,
      responseWindowMinutes: cfg.responseWindowMinutes,
    });
    scheduledBroadcastAt = anchors.scheduledBroadcastAt;
    scheduledConvertAt = anchors.scheduledConvertAt;
  }

  const defaultSearchExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const requestedMethod = body.payment_method || "card";

  const { passenger_name, passenger_phone } = resolveTripPassengerIdentity({
    bodyName: body.passenger_name,
    bodyPhone: body.passenger_phone,
    customerProfile: input.customerProfile,
  });

  const tripData: Record<string, unknown> = {
    passenger_id: customerId,
    passenger_name,
    passenger_phone,
    pickup_address: body.pickup.address,
    pickup_latitude: body.pickup.lat || 0,
    pickup_longitude: body.pickup.lng || 0,
    dropoff_address: body.dropoff.address,
    dropoff_latitude: body.dropoff.lat || 0,
    dropoff_longitude: body.dropoff.lng || 0,
    stops: intermediateStops,
    status: isScheduled ? "scheduled" : "searching",
    scheduled_at: isScheduled ? body.scheduled_at : null,
    scheduled_status: isScheduled ? "scheduled" : null,
    dispatch_mode: isScheduled ? "scheduled" : "instant",
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
        // Stripe retired — keep payment_intent_id via buildTripPaymentSyncPatch only.
        // Never write trips.stripe_payment_intent_id (column dropped).
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
    trip_type: isScheduled ? "scheduled" : "immediate",
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
    searching_expires_at: isScheduled ? null : defaultSearchExpiresAt,
    // Absolute sequences (Max Dispatch Rounds × 3). Post-commit overwrites from settings.
    max_broadcast_rounds: isScheduled ? null : 9,
  };

  const persistedBookingSource = resolvePersistedTripBookingSource({
    bodySource: body.booking_source,
    snapshotSource: sessionSnap?.booking_source,
    referer: input.requestReferer,
    origin: input.requestOrigin,
  });
  if (persistedBookingSource) {
    tripData.booking_source = persistedBookingSource;
  }

  if (body.pre_assigned_driver_id) {
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
