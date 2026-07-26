import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  handleCORSPreflight,
  successResponse,
  errorResponse,
  validationErrorResponse,
  isValidUUID,
} from "../_shared/security.ts";
import { isCallableTripStatus } from "../_shared/callMaskingConfig.ts";
import {
  readCommunicationProviderReadinessFromEnv,
  resolveTripCommunicationParticipant,
  resolveTripCommunicationSsot,
  toTripCommunicationConfigApiPayload,
  TRIP_COMMUNICATION_ERROR,
} from "../../../shared/tripCommunicationSsot.ts";

interface ConfigRequest {
  trip_id?: string;
}

/**
 * Privacy-safe trip communication capability projection.
 *
 * Security sequence:
 * 1. Authenticate via user JWT (user-scoped client)
 * 2. Resolve trip by id only (service area from trip, never from client body)
 * 3. Authorise confirmed/assigned Driver or owning Customer
 * 4. Only then read staff-only settings via service-role
 *
 * Does not loosen table RLS. Never returns secrets or phone numbers.
 * Uses production `_shared/security.ts` response conventions.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  if (req.method !== "POST") {
    return errorResponse("METHOD_NOT_ALLOWED", "Method not allowed", 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return errorResponse(
        TRIP_COMMUNICATION_ERROR.AUTH_REQUIRED,
        "Authentication required",
        401,
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) {
      return errorResponse(
        TRIP_COMMUNICATION_ERROR.AUTH_REQUIRED,
        "Authentication required",
        401,
      );
    }

    const body = (await req.json()) as ConfigRequest;
    const tripId = body.trip_id?.trim();
    if (!tripId || !isValidUUID(tripId)) {
      return validationErrorResponse({ trip_id: "Valid trip_id is required" });
    }

    // Trip ownership via user JWT / RLS — do not use service-role for this check.
    const { data: trip, error: tripError } = await userClient
      .from("trips")
      .select(
        "id, status, service_area_id, confirmed_driver_id, driver_id, passenger_id, trip_number, trip_code",
      )
      .eq("id", tripId)
      .maybeSingle();

    if (tripError) {
      console.error("[trip-communication-config] trip lookup failed", tripError.message);
      return errorResponse("INTERNAL_ERROR", "Failed to load trip", 500);
    }
    if (!trip) {
      return errorResponse(
        TRIP_COMMUNICATION_ERROR.TRIP_NOT_FOUND,
        "Trip not found",
        404,
      );
    }

    const { data: driverRow } = await userClient
      .from("drivers")
      .select("id, user_id")
      .eq("user_id", authData.user.id)
      .maybeSingle();

    // Customer ownership may be auth uid on trips.passenger_id OR customers.id.
    // Align with call-masking: resolve customer profile then match either id or user_id.
    const { data: customerRow } = await userClient
      .from("customers")
      .select("id, user_id")
      .eq("user_id", authData.user.id)
      .maybeSingle();

    const passengerId = trip.passenger_id;
    const customerOwnsTrip = Boolean(
      passengerId &&
        (passengerId === authData.user.id ||
          (customerRow?.id && passengerId === customerRow.id) ||
          (customerRow?.user_id && passengerId === customerRow.user_id)),
    );

    const participant = resolveTripCommunicationParticipant({
      authUserId: authData.user.id,
      driverProfileId: driverRow?.id ?? null,
      trip: {
        ...trip,
        // If customer owns via customers.id, present passenger_id as auth uid for role resolver.
        passenger_id: customerOwnsTrip ? authData.user.id : trip.passenger_id,
      },
    });
    if (!participant.ok) {
      return errorResponse(
        participant.errorCode,
        "You are not authorised to communicate on this trip.",
        403,
      );
    }

    const publicTripReference =
      (typeof trip.trip_number === "string" && trip.trip_number.trim()) ||
      (typeof trip.trip_code === "string" && trip.trip_code.trim()) ||
      null;

    // Authorised participant only — service-role reads staff-only settings tables.
    let settings = null;
    let maskingConfig = null;
    if (trip.service_area_id) {
      const { data: settingsRow, error: settingsError } = await serviceClient
        .from("service_area_communication_settings")
        .select(
          "is_enabled, voip_enabled, call_masking_enabled, default_method, maximum_call_duration_seconds, voip_rate_per_minute_minor, masked_call_rate_per_minute_minor, currency",
        )
        .eq("service_area_id", trip.service_area_id)
        .maybeSingle();

      if (settingsError) {
        console.error(
          "[trip-communication-config] settings lookup failed",
          settingsError.message,
        );
        return errorResponse("INTERNAL_ERROR", "Failed to load communication settings", 500);
      }
      settings = settingsRow;

      const { data: maskingRow, error: maskingError } = await serviceClient
        .from("service_area_call_masking_config")
        .select("outbound_caller_id, is_active, provider_config_id")
        .eq("service_area_id", trip.service_area_id)
        .maybeSingle();

      if (maskingError) {
        console.error(
          "[trip-communication-config] masking config lookup failed",
          maskingError.message,
        );
        return errorResponse("INTERNAL_ERROR", "Failed to load communication settings", 500);
      }
      maskingConfig = maskingRow;
    }

    const providerReadiness = readCommunicationProviderReadinessFromEnv(Deno.env);
    const ssot = resolveTripCommunicationSsot({
      tripId,
      publicTripReference,
      serviceAreaId: trip.service_area_id,
      actorRole: participant.role,
      participantAuthorised: true,
      lifecycleEligible: isCallableTripStatus(trip.status),
      settings,
      maskingConfig,
      providerReadiness,
    });

    return successResponse(toTripCommunicationConfigApiPayload(ssot));
  } catch (error) {
    console.error("[trip-communication-config] unexpected error", error);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
