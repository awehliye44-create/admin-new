import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  handleCORSPreflight,
  successResponse,
  errorResponse,
  validationErrorResponse,
  isValidUUID,
} from "../_shared/security.ts";
import { buildTripCommunicationConfigForTrip } from "../_shared/tripCommunicationConfigBuilder.ts";
import { loadTripCommunicationRuntimeContext } from "../_shared/serviceAreaCommunicationLookup.ts";
import { isCallableTripStatus } from "../_shared/callMaskingConfig.ts";
import { resolveTripCommunicationActor } from "../_shared/tripCommunicationActor.ts";
import { findActiveVoipCallLog } from "../_shared/voipCallLogs.ts";

interface ConfigRequest {
  trip_id?: string;
}

type ActorRole = "driver" | "customer";

function methodOption(input: {
  available: boolean;
  ready: boolean;
  unavailableReason: string | null;
}) {
  return {
    enabled: input.available,
    ready: input.ready,
    available: input.available,
    unavailable_reason: input.unavailableReason,
    can_start: input.available && input.ready,
  };
}

function buildActiveCallPayload(input: {
  callId: string;
  startedAt: string | null;
  connectedAt: string | null;
  expiresAt: string | null;
  joinAllowed: boolean;
}) {
  const remainingSeconds = input.expiresAt
    ? Math.max(0, Math.floor((Date.parse(input.expiresAt) - Date.now()) / 1000))
    : null;
  return {
    call_id: input.callId,
    method: "voip" as const,
    provider: "livekit" as const,
    status: "active" as const,
    started_at: input.startedAt,
    connected_at: input.connectedAt,
    expires_at: input.expiresAt,
    remaining_seconds: remainingSeconds,
    join_allowed: input.joinAllowed,
    end_allowed: true,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  if (req.method !== "POST") {
    return errorResponse("METHOD_NOT_ALLOWED", "POST required", 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return errorResponse("UNAUTHORIZED", "Unauthorized", 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) {
      return errorResponse("UNAUTHORIZED", "Unauthorized", 401);
    }
    const authUserId = authData.user.id;

    let body: ConfigRequest;
    try {
      body = (await req.json()) as ConfigRequest;
    } catch {
      return validationErrorResponse({ trip_id: "Valid trip_id is required" });
    }
    const tripId = body.trip_id?.trim();
    if (!tripId || !isValidUUID(tripId)) {
      return validationErrorResponse({ trip_id: "Valid trip_id is required" });
    }

    // Service-role trip load after JWT auth — user-scoped SELECT is blocked by RLS
    // for some participant roles and caused empty Call passenger sheets.
    const { data: trip, error: tripError } = await admin
      .from("trips")
      .select(
        "id, status, service_area_id, driver_id, confirmed_driver_id, passenger_id",
      )
      .eq("id", tripId)
      .maybeSingle();

    if (tripError) {
      console.error("[trip-communication-config] trip lookup failed", tripError);
      return errorResponse("TRIP_LOOKUP_FAILED", "Failed to load trip", 500);
    }
    if (!trip) {
      return errorResponse("NOT_FOUND", "Trip not found", 404);
    }

    const actor = await resolveTripCommunicationActor(admin, trip, authUserId);
    if (!actor) {
      return errorResponse("FORBIDDEN", "Forbidden", 403);
    }

    const actorRole: ActorRole = actor.role;
    const runtime = await loadTripCommunicationRuntimeContext(admin, trip);
    const legacy = await buildTripCommunicationConfigForTrip(admin, trip);
    const lifecycleEligible = isCallableTripStatus(trip.status);
    const callingAvailable = Boolean(legacy.calling_available) && lifecycleEligible;

    const voipAvailable = callingAvailable && legacy.voip_available !== false;
    const maskingAvailable =
      callingAvailable && legacy.call_masking_available === true;
    const maskingReady = maskingAvailable && Boolean(runtime.maskingCallerId);

    const disabledMessage = callingAvailable
      ? null
      : (legacy.disabled_message ?? "Calling is not available for this trip.");

    let activeCall = null;
    if (voipAvailable) {
      const activeLog = await findActiveVoipCallLog(admin, trip.id);
      if (
        activeLog &&
        (!activeLog.expires_at || Date.parse(activeLog.expires_at) > Date.now())
      ) {
        const joinAllowed = activeLog.initiator_user_id
          ? activeLog.initiator_user_id !== authUserId
          : activeLog.initiator_role
          ? activeLog.initiator_role !== actorRole
          : true;
        activeCall = buildActiveCallPayload({
          callId: activeLog.id,
          startedAt: activeLog.started_at,
          connectedAt: activeLog.connected_at,
          expiresAt: activeLog.expires_at,
          joinAllowed,
        });
      }
    }

    const payload = {
      trip_id: trip.id,
      public_trip_reference: null,
      service_area_id: trip.service_area_id,
      actor_role: actorRole,
      communication_enabled: callingAvailable,
      allowed: callingAvailable,
      blocked_reason: callingAvailable ? null : disabledMessage,
      default_method: maskingAvailable && legacy.methods?.[0]?.method === "call_masking"
        ? "call_masking"
        : voipAvailable
        ? "voip"
        : null,
      maximum_duration_seconds: legacy.maximum_call_duration_seconds,
      maximum_call_duration_seconds: legacy.maximum_call_duration_seconds,
      options: {
        voip: methodOption({
          available: voipAvailable,
          ready: voipAvailable,
          unavailableReason: voipAvailable ? null : disabledMessage,
        }),
        call_masking: methodOption({
          available: maskingAvailable,
          ready: maskingReady,
          unavailableReason: !maskingAvailable
            ? disabledMessage ?? "Secure phone call is not enabled for this service area."
            : !maskingReady
            ? "Secure phone call is temporarily unavailable."
            : null,
        }),
      },
      active_call: activeCall,
      methods: legacy.methods ?? [],
      calling_available: callingAvailable,
      voip_available: voipAvailable,
      call_masking_available: maskingAvailable,
      disabled_message: disabledMessage,
      config_version: legacy.config_version,
    };

    return successResponse(payload);
  } catch (error) {
    console.error("[trip-communication-config] unexpected error", error);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
