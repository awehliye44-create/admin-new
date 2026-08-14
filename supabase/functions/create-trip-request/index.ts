import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireServiceRole } from "../_shared/edgeAuth.ts";
import {
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  handleCORSPreflight,
  successResponse,
  errorResponse,
  isValidUUID,
  sanitizeString,
  isValidCoordinate,
  validationErrorResponse,
} from "../_shared/security.ts";
import {
  enforceTripServiceAreaForInsert,
  hasValidPickupCoordinates,
  logServiceAreaCorrection,
  PICKUP_OUTSIDE_SERVICE_AREAS_MESSAGE,
} from "../_shared/resolveTripServiceArea.ts";

const RATE_LIMIT_CONFIG = {
  limit: 20,
  windowMs: 60000,
  keyPrefix: 'create-trip-request'
};

interface TripStop {
  address: string;
  lat: number;
  lng: number;
  type: 'pickup' | 'stop' | 'dropoff';
}

interface TripRequestPayload {
  passenger_name: string;
  passenger_phone: string;
  passenger_email?: string;
  pickup_address: string;
  pickup_latitude: number;
  pickup_longitude: number;
  dropoff_address: string;
  dropoff_latitude: number;
  dropoff_longitude: number;
  estimated_fare: number;
  estimated_distance_km: number;
  estimated_duration_minutes: number;
  special_instructions?: string;
  assigned_driver_id?: string;
  passenger_id?: string;
  payment_method?: string;
  intermediate_stops?: TripStop[];
  service_area_id?: string;
  booking_source?: string;
}

Deno.serve(async (req) => {
  console.log("[create-trip-request] Received request:", req.method);
  
  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    console.warn("[create-trip-request] Rate limit exceeded for IP:", clientIP);
    return rateLimitResponse(rateLimitResult);
  }

  // Enforce service role credentials
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const auth = await requireServiceRole(req, supabaseServiceKey);
  if (!auth.ok) {
    console.warn("[create-trip-request] Unauthorized request blocked");
    return auth.response;
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const payload: TripRequestPayload = await req.json();
    console.log("[create-trip-request] Payload received");

    const validationErrors: Record<string, string> = {};

    const passengerName = sanitizeString(payload.passenger_name, 100);
    if (!passengerName) {
      validationErrors.passenger_name = "passenger_name is required (max 100 chars)";
    }

    const passengerPhone = sanitizeString(payload.passenger_phone, 20);
    if (!passengerPhone) {
      validationErrors.passenger_phone = "passenger_phone is required (max 20 chars)";
    }

    const pickupAddress = sanitizeString(payload.pickup_address, 500);
    if (!pickupAddress) {
      validationErrors.pickup_address = "pickup_address is required (max 500 chars)";
    }

    const dropoffAddress = sanitizeString(payload.dropoff_address, 500);
    if (!dropoffAddress) {
      validationErrors.dropoff_address = "dropoff_address is required (max 500 chars)";
    }

    const pickupLat = payload.pickup_latitude;
    const pickupLng = payload.pickup_longitude;

    if (pickupLat === undefined || pickupLng === undefined) {
      validationErrors.pickup_coordinates = "pickup_latitude and pickup_longitude are required";
    } else if (!isValidCoordinate(pickupLat, pickupLng)) {
      validationErrors.pickup_coordinates = "Invalid pickup coordinates";
    } else if (!hasValidPickupCoordinates(pickupLat, pickupLng)) {
      validationErrors.pickup_coordinates = "Pickup coordinates must be non-zero";
    }

    if (payload.dropoff_latitude !== undefined && payload.dropoff_longitude !== undefined) {
      if (!isValidCoordinate(payload.dropoff_latitude, payload.dropoff_longitude)) {
        validationErrors.dropoff_coordinates = "Invalid dropoff coordinates";
      }
    }

    if (payload.assigned_driver_id && !isValidUUID(payload.assigned_driver_id)) {
      validationErrors.assigned_driver_id = "assigned_driver_id must be a valid UUID";
    }

    if (payload.service_area_id && !isValidUUID(payload.service_area_id)) {
      validationErrors.service_area_id = "service_area_id must be a valid UUID";
    }

    if (Object.keys(validationErrors).length > 0) {
      console.log("[create-trip-request] Validation failed:", validationErrors);
      return validationErrorResponse(validationErrors);
    }

    const bookingSource = sanitizeString(payload.booking_source, 32) || "admin";

    const passengerId = payload.passenger_id || crypto.randomUUID();
    const intermediateStops = payload.intermediate_stops || [];
    const totalStops = 2 + intermediateStops.length;
    const specialInstructions = sanitizeString(payload.special_instructions, 1000);

    let tripData: Record<string, unknown> = {
      passenger_id: passengerId,
      passenger_name: passengerName,
      passenger_phone: passengerPhone,
      pickup_address: pickupAddress,
      pickup_latitude: pickupLat,
      pickup_longitude: pickupLng,
      dropoff_address: dropoffAddress,
      dropoff_latitude: payload.dropoff_latitude || 0,
      dropoff_longitude: payload.dropoff_longitude || 0,
      estimated_fare: payload.estimated_fare || 0,
      estimated_distance_km: payload.estimated_distance_km || 0,
      estimated_duration_minutes: payload.estimated_duration_minutes || 0,
      status: "pending",
      dispatch_status: "pending",
      driver_id: payload.assigned_driver_id || null,
      special_instructions: specialInstructions,
      payment_method: payload.payment_method || "cash",
      payment_status: "pending",
      trip_type: "immediate",
      is_scheduled: false,
      total_stops: totalStops,
      current_stop_index: 0,
      service_area_id: payload.service_area_id ?? null,
      booking_source: bookingSource,
    };

    let serviceAreaResolution;
    try {
      const enforced = await enforceTripServiceAreaForInsert(supabase, tripData, {
        pickupLat,
        pickupLng,
        selectedServiceAreaId: payload.service_area_id ?? null,
        bookingSource,
      });

      if (!enforced.ok) {
        return errorResponse(
          "PICKUP_OUTSIDE_SERVICE_AREA",
          PICKUP_OUTSIDE_SERVICE_AREAS_MESSAGE,
          400,
          enforced.resolution,
        );
      }

      tripData = enforced.tripRow;
      serviceAreaResolution = enforced.resolution;

      if (serviceAreaResolution.correction_applied) {
        console.warn("[create-trip-request] SERVICE_AREA_CORRECTED_FROM_PICKUP", {
          selected: serviceAreaResolution.selected_service_area_id,
          geofence: serviceAreaResolution.geofence_service_area_id,
          final: serviceAreaResolution.final_service_area_id,
        });
      }
    } catch (resolveErr) {
      console.error("[create-trip-request] Service area resolution failed:", resolveErr);
      return errorResponse("SERVICE_AREA_RESOLUTION_FAILED", "Could not resolve service area from pickup", 500);
    }

    console.log("[create-trip-request] Creating trip", {
      final_service_area_id: serviceAreaResolution.final_service_area_id,
      correction_applied: serviceAreaResolution.correction_applied,
    });

    const { data: trip, error } = await supabase
      .from("trips")
      .insert(tripData)
      .select()
      .single();

    if (error) {
      console.error("[create-trip-request] Error creating trip:", error);
      return errorResponse("DATABASE_ERROR", error.message, 500);
    }

    await logServiceAreaCorrection(supabase, trip.id, serviceAreaResolution, {
      pickup_lat: pickupLat,
      pickup_lng: pickupLng,
      booking_source: bookingSource,
    });

    console.log("[create-trip-request] Trip created successfully:", trip.id);

    const stopsToInsert = [
      {
        trip_id: trip.id,
        stop_index: 0,
        type: 'pickup',
        address: pickupAddress,
        lat: pickupLat,
        lng: pickupLng,
        status: 'pending',
      },
      ...intermediateStops.map((stop, index) => ({
        trip_id: trip.id,
        stop_index: index + 1,
        type: 'stop',
        address: sanitizeString(stop.address, 500) || 'Stop',
        lat: stop.lat || 0,
        lng: stop.lng || 0,
        status: 'pending',
      })),
      {
        trip_id: trip.id,
        stop_index: totalStops - 1,
        type: 'dropoff',
        address: dropoffAddress,
        lat: payload.dropoff_latitude || 0,
        lng: payload.dropoff_longitude || 0,
        status: 'pending',
      },
    ];

    const { error: stopsError } = await supabase
      .from("trip_stops")
      .insert(stopsToInsert);

    if (stopsError) {
      console.error("[create-trip-request] Error creating trip stops:", stopsError);
    }

    let dispatchResult = null;
    if (!payload.assigned_driver_id) {
      console.log("[create-trip-request] Triggering auto-dispatch for trip:", trip.id);
      
      try {
        const { data: dispatchData, error: dispatchError } = await supabase.functions.invoke("auto-dispatch", {
          body: { trip_id: trip.id },
        });

        if (dispatchError) {
          console.error("[create-trip-request] Auto-dispatch error:", dispatchError);
        } else {
          console.log("[create-trip-request] Auto-dispatch result:", JSON.stringify(dispatchData));
          dispatchResult = dispatchData;
        }
      } catch (dispatchErr) {
        console.error("[create-trip-request] Auto-dispatch exception:", dispatchErr);
      }
    }

    const { data: updatedTrip } = await supabase
      .from("trips")
      .select("*")
      .eq("id", trip.id)
      .single();

    return successResponse({ 
      success: true, 
      trip: updatedTrip || trip,
      stops_created: !stopsError,
      total_stops: totalStops,
      dispatch: dispatchResult,
      service_area: {
        selected_service_area_id: serviceAreaResolution.selected_service_area_id,
        geofence_service_area_id: serviceAreaResolution.geofence_service_area_id,
        final_service_area_id: serviceAreaResolution.final_service_area_id,
        pickup_lat: pickupLat,
        pickup_lng: pickupLng,
        correction_applied: serviceAreaResolution.correction_applied,
        mismatch_blocked: serviceAreaResolution.mismatch_blocked,
        warning: serviceAreaResolution.correction_applied
          ? `Service area corrected from ${serviceAreaResolution.selected_service_area_code ?? "selection"} to ${serviceAreaResolution.geofence_service_area_code ?? "geofence"} based on pickup location.`
          : null,
      },
    });

  } catch (err) {
    console.error("[create-trip-request] Unexpected error:", err);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
