import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { AccessToken } from "npm:livekit-server-sdk@2.9.1";
import {
  handleCORSPreflight,
  successResponse,
  errorResponse,
  validationErrorResponse,
  isValidUUID,
} from "../_shared/security.ts";
import { isCallableTripStatus } from "../_shared/callMaskingConfig.ts";
import {
  scheduleVoipMaxDurationEnforcement,
  startVoipCallLog,
} from "../_shared/voipCallLogs.ts";
import {
  readCommunicationProviderReadinessFromEnv,
  resolveTripCommunicationParticipant,
  resolveTripCommunicationSsot,
  resolveVoipTokenGate,
  TRIP_COMMUNICATION_ERROR,
} from "../../../shared/tripCommunicationSsot.ts";

interface TokenRequest {
  trip_id?: string;
}

/**
 * Issue a LiveKit participant token for an authorised trip participant.
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

    const body = (await req.json()) as TokenRequest;
    const tripId = body.trip_id?.trim();
    if (!tripId || !isValidUUID(tripId)) {
      return validationErrorResponse({ trip_id: "Valid trip_id is required" });
    }

    const livekitApiKey = Deno.env.get("LIVEKIT_API_KEY");
    const livekitApiSecret = Deno.env.get("LIVEKIT_API_SECRET");
    const livekitUrl = Deno.env.get("LIVEKIT_URL");

    const { data: trip, error: tripError } = await userClient
      .from("trips")
      .select(
        "id, status, service_area_id, confirmed_driver_id, driver_id, passenger_id",
      )
      .eq("id", tripId)
      .maybeSingle();

    if (tripError) {
      console.error("[livekit-voip-token] trip lookup failed", tripError.message);
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

    let settings = null;
    let maskingConfig = null;
    if (trip.service_area_id) {
      const { data, error: settingsError } = await serviceClient
        .from("service_area_communication_settings")
        .select(
          "is_enabled, voip_enabled, call_masking_enabled, default_method, maximum_call_duration_seconds",
        )
        .eq("service_area_id", trip.service_area_id)
        .maybeSingle();
      if (settingsError) {
        console.error("[livekit-voip-token] settings lookup failed", settingsError.message);
        return errorResponse("INTERNAL_ERROR", "Failed to load communication settings", 500);
      }
      settings = data;

      const { data: maskingRow } = await serviceClient
        .from("service_area_call_masking_config")
        .select("outbound_caller_id, is_active, provider_config_id")
        .eq("service_area_id", trip.service_area_id)
        .maybeSingle();
      maskingConfig = maskingRow;
    }

    const providerReadiness = readCommunicationProviderReadinessFromEnv(Deno.env);
    const ssot = resolveTripCommunicationSsot({
      tripId,
      serviceAreaId: trip.service_area_id,
      actorRole: participant.role,
      participantAuthorised: true,
      lifecycleEligible: isCallableTripStatus(trip.status),
      settings,
      maskingConfig,
      providerReadiness: {
        ...providerReadiness,
        livekitConfigured: Boolean(
          providerReadiness.livekitConfigured &&
            livekitApiKey &&
            livekitApiSecret &&
            livekitUrl,
        ),
      },
    });

    const gate = resolveVoipTokenGate(ssot);
    if (!gate.ok) {
      return errorResponse(gate.errorCode, gate.message, gate.status);
    }

    const participantIdentity = participant.role === "driver"
      ? `driver:${driverRow!.id}`
      : `customer:${authData.user.id}`;
    const participantName = participant.role === "driver" ? "Driver" : "Customer";

    const roomName = `trip-${tripId}`;
    const ttlSeconds = Math.max(60, ssot.maximumDurationSeconds);
    const assignedDriverId = participant.assignedDriverId;

    const callLogId = await startVoipCallLog(serviceClient, {
      trip_id: tripId,
      service_area_id: trip.service_area_id,
      driver_id: assignedDriverId,
      customer_id: trip.passenger_id,
    });

    if (callLogId) {
      scheduleVoipMaxDurationEnforcement(serviceClient, {
        logId: callLogId,
        roomName,
        maxSeconds: ttlSeconds,
        livekitUrl: livekitUrl!,
        livekitApiKey: livekitApiKey!,
        livekitApiSecret: livekitApiSecret!,
      });
    }

    const token = new AccessToken(livekitApiKey!, livekitApiSecret!, {
      identity: participantIdentity,
      name: participantName,
      ttl: ttlSeconds,
    });
    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });

    const jwt = await token.toJwt();

    return successResponse({
      token: jwt,
      livekit_url: livekitUrl,
      room_name: roomName,
      maximum_call_duration_seconds: ssot.maximumDurationSeconds,
      participant_identity: participantIdentity,
      call_log_id: callLogId,
    });
  } catch (error) {
    console.error("[livekit-voip-token] unexpected error", error);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
