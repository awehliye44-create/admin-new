import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { AccessToken } from "npm:livekit-server-sdk@2.9.1";
import {
  handleCORSPreflight,
  successResponse,
  errorResponse,
  validationErrorResponse,
  isValidUUID,
} from "../_shared/security.ts";
import { resolveTripCommunicationConfig } from "../_shared/tripCommunicationMethods.ts";
import {
  scheduleVoipMaxDurationEnforcement,
  startVoipCallLog,
} from "../_shared/voipCallLogs.ts";

interface TokenRequest {
  trip_id?: string;
}

Deno.serve(async (req) => {
  const preflight = handleCORSPreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return errorResponse("Unauthorized", 401);
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
      return errorResponse("Unauthorized", 401);
    }

    const body = (await req.json()) as TokenRequest;
    const tripId = body.trip_id?.trim();
    if (!tripId || !isValidUUID(tripId)) {
      return validationErrorResponse("Valid trip_id is required");
    }

    const livekitApiKey = Deno.env.get("LIVEKIT_API_KEY");
    const livekitApiSecret = Deno.env.get("LIVEKIT_API_SECRET");
    const livekitUrl = Deno.env.get("LIVEKIT_URL");
    if (!livekitApiKey || !livekitApiSecret || !livekitUrl) {
      console.error("[livekit-voip-token] LiveKit env not configured");
      return errorResponse("VoIP is not configured", 503);
    }

    const { data: trip, error: tripError } = await userClient
      .from("trips")
      .select("id, status, service_area_id, confirmed_driver_id, passenger_id")
      .eq("id", tripId)
      .maybeSingle();

    if (tripError || !trip) {
      return errorResponse("Trip not found", 404);
    }

    const { data: driverRow } = await userClient
      .from("drivers")
      .select("id, user_id, full_name")
      .eq("user_id", authData.user.id)
      .maybeSingle();

    const isDriver = driverRow?.id && trip.confirmed_driver_id === driverRow.id;
    const isPassenger = trip.passenger_id === authData.user.id;
    if (!isDriver && !isPassenger) {
      return errorResponse("Forbidden", 403);
    }

    let settings = null;
    if (trip.service_area_id) {
      const { data } = await userClient
        .from("service_area_communication_settings")
        .select(
          "is_enabled, voip_enabled, call_masking_enabled, default_method, maximum_call_duration_seconds",
        )
        .eq("service_area_id", trip.service_area_id)
        .maybeSingle();
      settings = data;
    }

    const config = resolveTripCommunicationConfig(trip.status, settings);
    const voipAllowed = config.methods.some((method) => method.method === "voip");
    if (!voipAllowed) {
      return errorResponse("VoIP is not enabled for this trip", 403);
    }

    const participantIdentity = isDriver
      ? `driver:${driverRow!.id}`
      : `customer:${authData.user.id}`;
    const participantName = isDriver
      ? driverRow?.full_name ?? "Driver"
      : "Customer";

    const roomName = `trip-${tripId}`;
    const ttlSeconds = Math.max(60, config.maximum_call_duration_seconds);

    const callLogId = await startVoipCallLog(serviceClient, {
      trip_id: tripId,
      service_area_id: trip.service_area_id,
      driver_id: trip.confirmed_driver_id,
      customer_id: trip.passenger_id,
    });

    if (callLogId) {
      scheduleVoipMaxDurationEnforcement(serviceClient, {
        logId: callLogId,
        roomName,
        maxSeconds: ttlSeconds,
        livekitUrl,
        livekitApiKey,
        livekitApiSecret,
      });
    }

    const token = new AccessToken(livekitApiKey, livekitApiSecret, {
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
      maximum_call_duration_seconds: config.maximum_call_duration_seconds,
      participant_identity: participantIdentity,
      call_log_id: callLogId,
    });
  } catch (error) {
    console.error("[livekit-voip-token] unexpected error", error);
    return errorResponse("Internal server error", 500);
  }
});
