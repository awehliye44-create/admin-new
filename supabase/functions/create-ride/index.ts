import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { 
  securityHeaders, 
  jsonHeaders,
  checkRateLimit, 
  rateLimitResponse, 
  getClientIP,
  isValidUUID,
  sanitizeString,
  isValidCoordinate,
  isPositiveNumber,
  handleCORSPreflight,
  validationErrorResponse,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import {
  computeScheduledDispatchAnchors,
  resolveScheduledDispatchConfig,
} from "../_shared/scheduledDispatchConfig.ts";
import { assertBookingSurgeAtPickup } from "../_shared/demandZoneSurgeSSOT.ts";

const RATE_LIMIT_CONFIG = { limit: 30, windowMs: 60000, keyPrefix: 'create-ride' };

// Maximum limits for validation
const MAX_PASSENGER_NAME_LENGTH = 100;
const MAX_PHONE_LENGTH = 30;
const MAX_ADDRESS_LENGTH = 500;
const MAX_INSTRUCTIONS_LENGTH = 1000;
const MAX_STOPS = 10;

interface TripStop {
  address: string;
  lat: number;
  lng: number;
  type?: 'pickup' | 'stop' | 'dropoff';
}

interface CreateRidePayload {
  pickup: {
    address: string;
    lat: number;
    lng: number;
  };
  dropoff: {
    address: string;
    lat: number;
    lng: number;
  };
  stops?: TripStop[];
  when: 'NOW' | 'SCHEDULED';
  scheduled_at?: string | null;
  client_action_id?: string;
  passenger_name: string;
  passenger_phone: string;
  /** Final, discounted, customer-payable fare — the same number "Request Ride" showed. */
  estimated_fare?: number;
  /**
   * Pre-discount reference fare (strikethrough display value). If omitted,
   * treated as equal to estimated_fare (no discount claimed).
   */
  original_estimated_fare?: number;
  /** Discount amount in major currency units (e.g. 0.32 = 32p). */
  discount_amount?: number;
  /** Personal voucher code — re-validated and re-priced server-side, never trusted as-is. */
  voucher_code?: string | null;
  /** Set when discount_amount is a non-voucher promo (e.g. automatic "X% off today" banner). */
  discount_source?: 'personal_voucher' | 'global_offer' | null;
  estimated_distance?: number;
  estimated_duration?: number;
  payment_method?: string;
  vehicle_type?: string;
  vehicle_type_id?: string;
  special_instructions?: string;
  /** Locked demand-zone surge quote from estimate-fare (client multiplier never trusted). */
  surge_quote?: {
    quote_id?: string;
    service_area_id?: string;
    zone_id?: string | null;
    confirmed_demand_level?: string | null;
    applied_multiplier?: number;
    quote_expires_at?: string;
    pickup_lat?: number;
    pickup_lng?: number;
  } | null;
  /** Deferred payment (long-advance bookings >6 days): skip preauth, reauth at T-24h */
  payment_deferred?: boolean;
  deferred_payment_method_id?: string;
}

/** Round major-currency-unit amount to integer minor units (pence), never negative. */
function toPence(amount: number | null | undefined): number {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

/**
 * Validate an individual stop object
 */
function validateStop(stop: TripStop, index: number): Record<string, string> {
  const errors: Record<string, string> = {};
  
  if (!stop.address || typeof stop.address !== 'string') {
    errors[`stops[${index}].address`] = 'Stop address is required';
  } else if (stop.address.length > MAX_ADDRESS_LENGTH) {
    errors[`stops[${index}].address`] = `Stop address must be less than ${MAX_ADDRESS_LENGTH} characters`;
  }
  
  if (stop.lat !== undefined && stop.lng !== undefined) {
    if (!isValidCoordinate(stop.lat, stop.lng)) {
      errors[`stops[${index}].coordinates`] = 'Invalid stop coordinates (lat: -90 to 90, lng: -180 to 180)';
    }
  }
  
  return errors;
}

async function resolveVehicleTypeIdForInsert(
  supabase: ReturnType<typeof createClient>,
  payload: Pick<CreateRidePayload, "vehicle_type_id" | "vehicle_type">,
): Promise<string | null> {
  if (payload.vehicle_type_id && isValidUUID(payload.vehicle_type_id)) {
    return payload.vehicle_type_id.trim();
  }

  const legacySlug = (payload.vehicle_type || "economy").trim();
  if (!legacySlug) return null;

  const { data: vehicleType } = await supabase
    .from("vehicle_types")
    .select("id")
    .eq("slug", legacySlug)
    .maybeSingle();

  return (vehicleType?.id as string | undefined) ?? null;
}

/**
 * Create Ride Edge Function
 * 
 * Called by customer app to create a new trip and dispatch to drivers.
 * After creating the trip it invokes Edge Function auto-dispatch, which evaluates
 * driver_presence-backed eligibility and waves — wholly independent from any
 * passenger-map RPC (driver_live_locations / passenger_map_nearby_drivers).
 * Never block booking on “nearby driver pin” counts shown to the rider.
 * 
 * Security features:
 * - Rate limiting (30 req/min per IP)
 * - Comprehensive input validation
 * - Coordinate range validation
 * - String length limits
 * - Sanitization of user inputs
 */
Deno.serve(async (req) => {
  console.log("[create-ride] Received request:", req.method);

  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  return errorResponse(
    "USE_CREATE_TRIP_AFTER_PAYMENT",
    "create-ride is retired. Use create-trip-after-payment for all paid bookings.",
    410,
  );
  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    console.log("[create-ride] Rate limit exceeded for IP:", clientIP);
    return rateLimitResponse(rateLimitResult);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get auth user from request header
    const authHeader = req.headers.get("Authorization");
    let userId: string | null = null;
    let customerId: string | null = null;

    if (authHeader) {
      const token = authHeader.replace("Bearer ", "");
      const { data: { user } } = await supabase.auth.getUser(token);
      userId = user?.id || null;

      // Get customer record if logged in
      if (userId) {
        const { data: customer } = await supabase
          .from("customers")
          .select("id")
          .eq("user_id", userId)
          .single();
        customerId = customer?.id || null;
      }
    }

    let payload: CreateRidePayload;
    try {
      payload = await req.json();
    } catch {
      return errorResponse("PARSE_ERROR", "Invalid JSON payload", 400);
    }
    
    console.log("[create-ride] Processing ride request");

    // Comprehensive input validation
    const validationErrors: Record<string, string> = {};

    // Validate passenger name
    if (!payload.passenger_name || typeof payload.passenger_name !== 'string') {
      validationErrors.passenger_name = "passenger_name is required";
    } else if (payload.passenger_name.length > MAX_PASSENGER_NAME_LENGTH) {
      validationErrors.passenger_name = `passenger_name must be less than ${MAX_PASSENGER_NAME_LENGTH} characters`;
    }

    // Validate passenger phone
    if (!payload.passenger_phone || typeof payload.passenger_phone !== 'string') {
      validationErrors.passenger_phone = "passenger_phone is required";
    } else if (payload.passenger_phone.length > MAX_PHONE_LENGTH) {
      validationErrors.passenger_phone = `passenger_phone must be less than ${MAX_PHONE_LENGTH} characters`;
    }

    // Validate pickup
    if (!payload.pickup) {
      validationErrors.pickup = "pickup location is required";
    } else {
      if (!payload.pickup.address || typeof payload.pickup.address !== 'string') {
        validationErrors['pickup.address'] = "pickup address is required";
      } else if (payload.pickup.address.length > MAX_ADDRESS_LENGTH) {
        validationErrors['pickup.address'] = `pickup address must be less than ${MAX_ADDRESS_LENGTH} characters`;
      }
      
      if (payload.pickup.lat !== undefined && payload.pickup.lng !== undefined) {
        if (!isValidCoordinate(payload.pickup.lat, payload.pickup.lng)) {
          validationErrors['pickup.coordinates'] = "Invalid pickup coordinates (lat: -90 to 90, lng: -180 to 180)";
        }
      }
    }

    // Validate dropoff
    if (!payload.dropoff) {
      validationErrors.dropoff = "dropoff location is required";
    } else {
      if (!payload.dropoff.address || typeof payload.dropoff.address !== 'string') {
        validationErrors['dropoff.address'] = "dropoff address is required";
      } else if (payload.dropoff.address.length > MAX_ADDRESS_LENGTH) {
        validationErrors['dropoff.address'] = `dropoff address must be less than ${MAX_ADDRESS_LENGTH} characters`;
      }
      
      if (payload.dropoff.lat !== undefined && payload.dropoff.lng !== undefined) {
        if (!isValidCoordinate(payload.dropoff.lat, payload.dropoff.lng)) {
          validationErrors['dropoff.coordinates'] = "Invalid dropoff coordinates (lat: -90 to 90, lng: -180 to 180)";
        }
      }
    }

    // Validate intermediate stops
    if (payload.stops) {
      if (!Array.isArray(payload.stops)) {
        validationErrors.stops = "stops must be an array";
      } else if (payload.stops.length > MAX_STOPS) {
        validationErrors.stops = `Maximum ${MAX_STOPS} intermediate stops allowed`;
      } else {
        payload.stops.forEach((stop, index) => {
          const stopErrors = validateStop(stop, index);
          Object.assign(validationErrors, stopErrors);
        });
      }
    }

    // Validate when field
    if (!payload.when || !['NOW', 'SCHEDULED'].includes(payload.when)) {
      validationErrors.when = "when must be 'NOW' or 'SCHEDULED'";
    }

    // Validate scheduled_at for scheduled rides
    if (payload.when === 'SCHEDULED') {
      if (!payload.scheduled_at) {
        validationErrors.scheduled_at = "scheduled_at is required for scheduled rides";
      } else {
        const scheduledDate = new Date(payload.scheduled_at);
        if (isNaN(scheduledDate.getTime())) {
          validationErrors.scheduled_at = "scheduled_at must be a valid ISO date string";
        } else if (scheduledDate <= new Date()) {
          validationErrors.scheduled_at = "scheduled_at must be in the future";
        } else {
          // Server-side enforcement of minimum advance booking time.
          // Fetch min_advance_time_minutes from dispatch_settings (service-area-aware).
          // This prevents API-level bypass of the client-side lead-time guard.
          try {
            const { data: dispatchSettings } = await supabase
              .from("dispatch_settings")
              .select("min_advance_time_minutes")
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();

            const minAdvanceMinutes: number =
              dispatchSettings?.min_advance_time_minutes != null &&
              Number.isFinite(Number(dispatchSettings.min_advance_time_minutes)) &&
              Number(dispatchSettings.min_advance_time_minutes) > 0
                ? Number(dispatchSettings.min_advance_time_minutes)
                : 15; // Hard fallback

            const minAllowedMs = Date.now() + minAdvanceMinutes * 60_000;
            if (scheduledDate.getTime() < minAllowedMs) {
              validationErrors.scheduled_at =
                `Scheduled pickup must be at least ${minAdvanceMinutes} minutes from now`;
            }
          } catch {
            // Non-fatal: if the settings query fails, skip the min-advance check
            // to avoid blocking a booking due to a transient DB hiccup.
          }
        }
      }
    }

    // Validate optional numeric fields
    if (payload.estimated_fare !== undefined && !isPositiveNumber(payload.estimated_fare) && payload.estimated_fare !== 0) {
      validationErrors.estimated_fare = "estimated_fare must be a positive number";
    }

    if (payload.estimated_distance !== undefined && !isPositiveNumber(payload.estimated_distance) && payload.estimated_distance !== 0) {
      validationErrors.estimated_distance = "estimated_distance must be a positive number";
    }

    if (payload.estimated_duration !== undefined && !isPositiveNumber(payload.estimated_duration) && payload.estimated_duration !== 0) {
      validationErrors.estimated_duration = "estimated_duration must be a positive number";
    }

    // Validate special_instructions length
    if (payload.special_instructions && payload.special_instructions.length > MAX_INSTRUCTIONS_LENGTH) {
      validationErrors.special_instructions = `special_instructions must be less than ${MAX_INSTRUCTIONS_LENGTH} characters`;
    }

    // Validate client_action_id if provided
    if (payload.client_action_id && !isValidUUID(payload.client_action_id)) {
      validationErrors.client_action_id = "client_action_id must be a valid UUID";
    }

    if (payload.vehicle_type_id && !isValidUUID(payload.vehicle_type_id)) {
      validationErrors.vehicle_type_id = "vehicle_type_id must be a valid UUID";
    }

    // Return validation errors if any
    if (Object.keys(validationErrors).length > 0) {
      console.log("[create-ride] Validation errors:", Object.keys(validationErrors).length);
      return validationErrorResponse(validationErrors);
    }

    // ── Fare SSOT: resolve + validate the discounted payable fare ──────────
    // Hard rule: estimated_fare persisted on the trip MUST equal
    // original_estimated_fare - discount_amount (±1p rounding tolerance).
    // A discount is never trusted blind from the client — a personal voucher
    // is always re-priced server-side; any other discount_amount is checked
    // arithmetically against what the client claims as the original fare.
    const originalFarePence = toPence(payload.original_estimated_fare ?? payload.estimated_fare);
    let discountPence = 0;
    let discountSource: "personal_voucher" | "global_offer" | null = null;
    let appliedVoucherId: string | null = null;
    let appliedVoucherCode: string | null = null;

    if (payload.voucher_code && payload.voucher_code.trim()) {
      if (!customerId) {
        return errorResponse(
          "VOUCHER_REQUIRES_ACCOUNT",
          "Sign in to use a personal voucher.",
          400,
        );
      }
      const { resolvePersonalVoucherForTrip, PERSONAL_VOUCHER_ERROR_MESSAGES } =
        await import("../_shared/resolve-personal-voucher.ts");
      const voucherResult = await resolvePersonalVoucherForTrip({
        admin: supabase,
        code: payload.voucher_code,
        customerId,
        estimatedFarePence: originalFarePence,
      });
      if (!voucherResult.ok) {
        return errorResponse(
          "VOUCHER_INVALID",
          PERSONAL_VOUCHER_ERROR_MESSAGES[voucherResult.error],
          400,
        );
      }
      // Server-computed discount — the client's discount_amount is ignored here.
      discountPence = voucherResult.resolved.discountPence;
      discountSource = "personal_voucher";
      appliedVoucherId = voucherResult.resolved.voucherId;
      appliedVoucherCode = voucherResult.resolved.voucherCode;
    } else if (payload.discount_amount != null && payload.discount_amount > 0) {
      discountPence = Math.min(toPence(payload.discount_amount), originalFarePence);
      discountSource = payload.discount_source === "personal_voucher" ? "global_offer" : (payload.discount_source ?? "global_offer");
    }

    const expectedFarePence = Math.max(originalFarePence - discountPence, 0);
    const providedFarePence = toPence(payload.estimated_fare);

    if (Math.abs(expectedFarePence - providedFarePence) > 1) {
      console.warn("[create-ride] FARE_SSOT_MISMATCH", JSON.stringify({
        original_estimated_fare_pence: originalFarePence,
        discount_pence: discountPence,
        expected_estimated_fare_pence: expectedFarePence,
        provided_estimated_fare_pence: providedFarePence,
      }));
      return errorResponse(
        "FARE_SSOT_MISMATCH",
        "The fare shown does not match the discount applied. Please refresh and try again.",
        400,
      );
    }

    // Sanitize inputs
    const sanitizedName = sanitizeString(payload.passenger_name, MAX_PASSENGER_NAME_LENGTH);
    const sanitizedPhone = sanitizeString(payload.passenger_phone, MAX_PHONE_LENGTH);
    const sanitizedInstructions = payload.special_instructions
      ? sanitizeString(payload.special_instructions, MAX_INSTRUCTIONS_LENGTH)
      : null;

    const {
      enforceTripServiceAreaForInsert,
      hasValidPickupCoordinates,
      PICKUP_OUTSIDE_SERVICE_AREAS_MESSAGE,
    } = await import("../_shared/resolveTripServiceArea.ts");

    if (
      payload.when === "NOW"
      && !hasValidPickupCoordinates(payload.pickup.lat, payload.pickup.lng)
    ) {
      return validationErrorResponse({
        "pickup.coordinates": "Valid pickup coordinates are required",
      });
    }

    let serviceAreaId: string | null = null;
    let serviceAreaCode: string | null = null;
    let serviceAreaRegionId: string | null = null;
    let serviceAreaResolution: import("../_shared/resolveTripServiceArea.ts").TripServiceAreaResolution | null = null;

    if (hasValidPickupCoordinates(payload.pickup.lat, payload.pickup.lng)) {
      const precheck = await enforceTripServiceAreaForInsert(
        supabase,
        { service_area_id: null },
        {
          pickupLat: payload.pickup.lat,
          pickupLng: payload.pickup.lng,
          bookingSource: "customer",
        },
      );

      if (!precheck.ok) {
        return errorResponse(
          "PICKUP_OUTSIDE_SERVICE_AREA",
          PICKUP_OUTSIDE_SERVICE_AREAS_MESSAGE,
          400,
          precheck.resolution,
        );
      }

      serviceAreaResolution = precheck.resolution;
      serviceAreaId = precheck.resolution.final_service_area_id;
      serviceAreaCode = precheck.resolution.final_service_area_code;
      serviceAreaRegionId = precheck.resolution.region_id;
      console.log("[create-ride] Resolved service area from pickup geofence:", serviceAreaId);
    }

    // Generate trip code
    const tripCode = String(Math.floor(100000 + Math.random() * 900000));

    // Get trip number sequence
    let tripNumber: string | null = null;
    if (serviceAreaId) {
      const { data: sequence } = await supabase
        .from("service_area_sequences")
        .select("*")
        .eq("service_area_id", serviceAreaId)
        .eq("sequence_type", "trip")
        .single();

      if (sequence) {
        const nextVal = sequence.current_value + 1;
        await supabase
          .from("service_area_sequences")
          .update({ current_value: nextVal })
          .eq("id", sequence.id);
        tripNumber = `${sequence.service_area_code}${String(nextVal).padStart(3, '0')}`;
        console.log("[create-ride] Assigned trip number:", tripNumber);
      }
    }

    // Build intermediate stops array
    const intermediateStops = payload.stops || [];
    const totalStops = 2 + intermediateStops.length;

    // Calculate scheduled broadcast/convert times for scheduled rides
    let scheduledBroadcastAt: string | null = null;
    let scheduledConvertAt: string | null = null;

    if (payload.when === 'SCHEDULED' && payload.scheduled_at) {
      const { data: globalCfg } = await supabase
        .from("global_dispatch_settings")
        .select(
          "enable_scheduled_to_urgent_conversion, scheduled_response_window_minutes, urgent_dispatch_trigger_minutes_before_pickup, locked_driver_response_minutes, max_driver_find_time_minutes, scheduled_urgent_card_label",
        )
        .eq("singleton", true)
        .maybeSingle();
      const cfg = resolveScheduledDispatchConfig(globalCfg);
      const anchors = computeScheduledDispatchAnchors({
        scheduledAtIso: payload.scheduled_at,
        urgentTriggerMinutesBeforePickup: cfg.urgentTriggerMinutesBeforePickup,
        responseWindowMinutes: cfg.responseWindowMinutes,
      });
      scheduledBroadcastAt = anchors.scheduledBroadcastAt;
      scheduledConvertAt = anchors.scheduledConvertAt;
    }

    // Create trip:
    // - IMMEDIATE rides: status="searching" (ready for auto-dispatch)
    // - SCHEDULED rides: status="requested" (waits for scheduled-dispatch pipeline)
    const isScheduled = payload.when === 'SCHEDULED';
    const initialStatus = isScheduled ? "requested" : "searching";

    const resolvedVehicleTypeId = await resolveVehicleTypeIdForInsert(supabase, payload);
    if (!isScheduled && !resolvedVehicleTypeId) {
      return errorResponse(
        "VEHICLE_TYPE_REQUIRED",
        "A vehicle type is required to create a ride. Please select a vehicle first.",
        400,
      );
    }

    let surgeMultiplier = 1;
    if (
      payload.surge_quote?.applied_multiplier != null
      && serviceAreaId
      && hasValidPickupCoordinates(payload.pickup.lat, payload.pickup.lng)
    ) {
      const surgeCheck = await assertBookingSurgeAtPickup(supabase, {
        serviceAreaId,
        pickupLat: payload.pickup.lat,
        pickupLng: payload.pickup.lng,
        surgeQuote: payload.surge_quote,
      });
      if (!surgeCheck.ok) {
        return errorResponse(
          surgeCheck.code,
          surgeCheck.message,
          surgeCheck.code === "SURGE_QUOTE_STALE" ? 409 : 400,
        );
      }
      surgeMultiplier = surgeCheck.multiplier;
    }
    
    const tripData = {
      passenger_id: customerId || crypto.randomUUID(),
      passenger_name: payload.passenger_name,
      passenger_phone: payload.passenger_phone,
      pickup_address: payload.pickup.address,
      pickup_latitude: payload.pickup.lat || 0,
      pickup_longitude: payload.pickup.lng || 0,
      dropoff_address: payload.dropoff.address,
      dropoff_latitude: payload.dropoff.lat || 0,
      dropoff_longitude: payload.dropoff.lng || 0,
      stops: intermediateStops,
      status: initialStatus,
      scheduled_at: payload.scheduled_at || null,
      scheduled_status: isScheduled ? 'scheduled' : null, // 'scheduled' for the dispatch pipeline
      dispatch_mode: isScheduled ? 'scheduled' : 'instant',
      scheduled_broadcast_at: scheduledBroadcastAt,
      scheduled_convert_at: scheduledConvertAt,
      client_action_id: payload.client_action_id || null,
      trip_code: tripCode,
      trip_number: tripNumber,
      // Fare SSOT: fare/estimated_fare are ALWAYS the discounted, customer-payable
      // amount — never the pre-discount original. original_estimated_fare only
      // ever surfaces via gross_fare_pence, for strikethrough/reference display.
      fare: expectedFarePence / 100,
      estimated_fare: expectedFarePence / 100,
      gross_fare_pence: originalFarePence || null,
      // Populated at booking time (not just at driver/offer accept) so every
      // downstream reader of the shared fare SSOT resolver (_shared/tripFareSSOT.ts)
      // — active trip, rating, receipt, admin, capture — sees the same discounted
      // figure from the moment the trip is created.
      locked_base_fare_pence: expectedFarePence || null,
      final_customer_fare_pence: expectedFarePence || null,
      discount_pence: discountPence,
      discount_source: discountSource,
      ...(discountSource === "personal_voucher" ? { voucher_discount_pence: discountPence } : {}),
      ...(discountSource === "global_offer" ? { offer_discount_pence: discountPence } : {}),
      ...(appliedVoucherId
        ? { applied_personal_voucher_id: appliedVoucherId, applied_personal_voucher_code: appliedVoucherCode }
        : {}),
      estimated_distance_km: payload.estimated_distance || 0,
      estimated_duration_minutes: payload.estimated_duration || 0,
      payment_method: payload.payment_method || "cash",
      payment_type: payload.payment_method || "cash",
      payment_status: "pending",
      trip_type: isScheduled ? 'scheduled' : 'immediate',
      currency: "GBP",
      currency_code: "gbp",
      surge_multiplier: surgeMultiplier,
      is_scheduled: isScheduled,
      job_type: "ride",
      total_stops: totalStops,
      current_stop_index: 0,
      service_area_id: serviceAreaId,
      service_area_code: serviceAreaCode,
      region_id: serviceAreaRegionId,
      booking_source: "customer",
      special_instructions: payload.special_instructions || null,
      vehicle_type: payload.vehicle_type || "economy",
      vehicle_type_id: resolvedVehicleTypeId,
      // §9 SSOT: scheduled trips start as 'available' for the public banner.
      // dispatch_status progresses: available → scheduled_committed (at cron commitment) → assigned.
      ...(isScheduled ? { dispatch_status: "available" } : {}),
      // Deferred payment: long-advance bookings skip the upfront card preauth.
      // A cron job (scheduled-payment-reauth) creates a fresh PaymentIntent at T-24h.
      ...(payload.payment_deferred && payload.deferred_payment_method_id
        ? {
            payment_deferred: true,
            deferred_payment_method_id: payload.deferred_payment_method_id,
            payment_reauth_status: "pending",
          }
        : {}),
    };

    let rowToInsert: Record<string, unknown> = { ...tripData };

    if (hasValidPickupCoordinates(payload.pickup.lat, payload.pickup.lng)) {
      const enforced = await enforceTripServiceAreaForInsert(supabase, rowToInsert, {
        pickupLat: payload.pickup.lat,
        pickupLng: payload.pickup.lng,
        bookingSource: "customer",
      });
      if (!enforced.ok) {
        return errorResponse(
          "PICKUP_OUTSIDE_SERVICE_AREA",
          PICKUP_OUTSIDE_SERVICE_AREAS_MESSAGE,
          400,
          enforced.resolution,
        );
      }
      rowToInsert = enforced.tripRow;
      serviceAreaResolution = enforced.resolution;
    }

    console.log("[create-ride] Inserting trip data:", JSON.stringify(rowToInsert));

    const { data: trip, error: tripError } = await supabase
      .from("trips")
      .insert(rowToInsert)
      .select()
      .single();

    if (tripError) {
      console.error("[create-ride] Error creating trip:", tripError);
      return errorResponse("DATABASE_ERROR", "Failed to create trip", 500);
    }

    console.log("[create-ride] Ride created successfully:", trip.id);

    if (serviceAreaResolution) {
      const { logServiceAreaCorrection } = await import("../_shared/resolveTripServiceArea.ts");
      await logServiceAreaCorrection(supabase, trip.id, serviceAreaResolution, {
        pickup_lat: payload.pickup.lat,
        pickup_lng: payload.pickup.lng,
        booking_source: "customer",
      });
    }

    // Create trip_stops entries
    const stopsToInsert = [
      {
        trip_id: trip.id,
        stop_index: 0,
        type: 'pickup',
        address: payload.pickup.address,
        lat: payload.pickup.lat || 0,
        lng: payload.pickup.lng || 0,
        status: 'pending',
      },
      ...intermediateStops.map((stop, index) => ({
        trip_id: trip.id,
        stop_index: index + 1,
        type: 'stop' as const,
        address: stop.address,
        lat: stop.lat || 0,
        lng: stop.lng || 0,
        status: 'pending',
      })),
      {
        trip_id: trip.id,
        stop_index: totalStops - 1,
        type: 'dropoff',
        address: payload.dropoff.address,
        lat: payload.dropoff.lat || 0,
        lng: payload.dropoff.lng || 0,
        status: 'pending',
      },
    ];

    const { error: stopsError } = await supabase
      .from("trip_stops")
      .insert(stopsToInsert);

    if (stopsError) {
      console.error("[create-ride] Error creating trip stops:", stopsError);
    } else {
      console.log("[create-ride] Created", stopsToInsert.length, "trip stops");
    }

    // Update customer's active_trip_id if logged in
    if (customerId) {
      await supabase
        .from("customers")
        .update({ active_trip_id: trip.id })
        .eq("id", customerId);
      console.log("[create-ride] Customer active_trip_id updated to:", trip.id);
    }

    // §18 — Notify customer that their scheduled booking was received.
    // Fire-and-forget: do not let notification failure block the booking response.
    if (isScheduled && trip.passenger_id) {
      const pickupDate = new Date(trip.scheduled_at ?? "").toLocaleString("en-GB", {
        weekday: "short", day: "numeric", month: "short",
        hour: "2-digit", minute: "2-digit",
      });
      supabase.functions.invoke("send-customer-notification", {
        body: {
          customer_id: trip.passenger_id,
          passengerId: trip.passenger_id,
          type: "SCHEDULED_BOOKING_CONFIRMED",
          title: "Scheduled ride booked",
          body: `Your ride is booked for ${pickupDate}. We'll notify you when a driver confirms.`,
          data: {
            trip_id: trip.id,
            trip_number: tripNumber ?? "",
            scheduled_at: trip.scheduled_at ?? "",
            type: "scheduled_booking_confirmed",
          },
        },
      }).catch((err: unknown) => {
        console.warn("[create-ride] Scheduled booking push failed (non-fatal):", err);
      });
    }

    // CRITICAL: Trigger auto-dispatch for immediate rides
    let dispatchResult = null;
    if (payload.when === 'NOW') {
      console.log("[create-ride] Triggering auto-dispatch for trip:", trip.id);
      
      try {
        // Use direct fetch to avoid edge-to-edge function invoke issues
        const dispatchUrl = `${supabaseUrl}/functions/v1/auto-dispatch`;
        const dispatchResponse = await fetch(dispatchUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({ trip_id: trip.id }),
        });

        const dispatchData = await dispatchResponse.json();
        
        if (!dispatchResponse.ok) {
          console.error("[create-ride] Auto-dispatch failed:", dispatchResponse.status, JSON.stringify(dispatchData));
        } else {
          console.log("[create-ride] Auto-dispatch success:", JSON.stringify(dispatchData));
          dispatchResult = dispatchData;
        }
      } catch (dispatchErr) {
        console.error("[create-ride] Auto-dispatch exception:", dispatchErr);
      }
    }

    // Fetch updated trip after dispatch
    const { data: updatedTrip } = await supabase
      .from("trips")
      .select("*")
      .eq("id", trip.id)
      .single();

    return successResponse({
      success: true,
      trip: updatedTrip || trip,
      trip_id: trip.id,
      trip_code: tripCode,
      trip_number: tripNumber,
      stops_created: !stopsError,
      total_stops: totalStops,
      dispatch: dispatchResult,
    });

  } catch (error) {
    console.error("[create-ride] Error:", error);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
